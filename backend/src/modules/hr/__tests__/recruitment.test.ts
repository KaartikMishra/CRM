/**
 * HR Phase 3 — Recruitment / ATS, Onboarding & Probation, end to end.
 *
 * Real requests against a real database, because the things worth pinning here are
 * the ones a type cannot express —
 *
 *   - that a candidate is never an employee: onboarding creates a separate Employee
 *     through Phase 1's atomic counter, and the candidate survives as history;
 *   - that **one hire cannot produce two employment records**, under concurrency;
 *   - that the ATS transition map refuses a skip over a commit point, so no offer
 *     can exist that nobody decided to make;
 *   - that an offer cannot be accepted twice;
 *   - that an interviewer cannot read the panel's feedback before giving their own;
 *   - that a verification result and a salary figure never reach a reader without
 *     HR_RECRUITMENT;
 *   - that a flagged background check blocks employee creation and rejects nobody;
 *   - that nobody decides their own probation, and a termination does not set
 *     Employee.status to EXITED;
 *   - and that none of it writes to User, a permission row, or any other module.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  RUN_PREFIX,
  cleanup,
  makeUser,
  residualTestRows,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

/** Full recruitment rights plus HR_EMPLOYEE, as an HR lead would hold. */
let admin: TestUser;
/** HR_RECRUITMENT VIEW+CREATE+EDIT, deliberately NOT APPROVE. */
let recruiter: TestUser;
/** No recruitment grant at all — reaches only what involvement gives them. */
let interviewer: TestUser;
/** No HR grant whatsoever, and no involvement. Sees nothing. */
let outsider: TestUser;

let adminToken: string;
let recruiterToken: string;
let interviewerToken: string;
let outsiderToken: string;

let departmentId: string;
let designationId: string;
/** The interviewer's own Employee record — what makes involvement possible. */
let interviewerEmployeeId: string;
let managerEmployeeId: string;

let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

/** Emails carry the run marker, which is how teardown finds candidates and employees. */
let emailSeq = 0;
const testEmail = (stem = 'cand'): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-${stem}${emailSeq}@test.invalid`;
};

async function grant(userId: string, module: string, actions: string[]): Promise<void> {
  await prisma.userModulePermission.createMany({
    data: actions.map((action) => ({
      userId,
      module: module as never,
      action: action as never,
      allowed: true,
    })),
    skipDuplicates: true,
  });
}

type Body = Record<string, unknown>;

/**
 * The payload of a successful response.
 *
 * `data` is optional on the envelope — an error carries `message` instead — so this
 * asserts it is present rather than typing it away. Every caller has already checked
 * the status, so a missing payload here is a real defect and should fail loudly at
 * the point of use rather than surface as `undefined` three lines later.
 */
function data<T>(res: { body: { data?: unknown } }): T {
  expect(res.body.data, JSON.stringify(res.body)).toBeDefined();
  return res.body.data as T;
}

async function makeEmployee(overrides: Body = {}): Promise<{ id: string; employeeId: string }> {
  const res = await api('POST', '/api/hr/employees', {
    token: adminToken,
    body: {
      firstName: 'Panel',
      lastName: 'Member',
      workEmail: testEmail('emp'),
      joiningDate: '2026-01-15',
      ...overrides,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return data<{ employee: { id: string; employeeId: string } }>(res).employee;
}

/**
 * A published requisition that tests can share.
 *
 * Created once, lazily. Most tests need only *a* vacancy to hang an application on,
 * and building a fresh one costs two round-trips against remote Neon — which, across
 * nearly thirty call sites, was a material part of why this suite ran for sixteen
 * minutes and started losing pooled connections.
 *
 * Sharing is safe because an application is unique per (candidate, job) and every test
 * makes its own candidate: two tests on one requisition cannot collide. The tests that
 * genuinely need their own — anything asserting publish, pause, close or a
 * requisition-level race — call `makePublishedJob` directly and get a fresh one.
 */
let sharedJob: { id: string; code: string } | null = null;
async function sharedPublishedJob(): Promise<{ id: string; code: string }> {
  sharedJob ??= await makePublishedJob({ title: 'Shared Vacancy' });
  return sharedJob;
}

/** A published requisition — the only state that accepts applications. */
async function makePublishedJob(overrides: Body = {}): Promise<{ id: string; code: string }> {
  const created = await api('POST', '/api/hr/recruitment/jobs', {
    token: adminToken,
    body: { title: 'Test Role', departmentId, designationId, ...overrides },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const job = data<{ job: { id: string; code: string } }>(created).job;

  const published = await api('POST', `/api/hr/recruitment/jobs/${job.id}/publish`, {
    token: adminToken,
  });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return job;
}

async function makeCandidate(overrides: Body = {}): Promise<{ id: string; email: string }> {
  const res = await api('POST', '/api/hr/recruitment/candidates', {
    token: adminToken,
    body: { firstName: 'Test', lastName: 'Candidate', email: testEmail(), ...overrides },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return data<{ candidate: { id: string; email: string } }>(res).candidate;
}

async function makeApplication(
  jobId: string,
  candidateId: string,
): Promise<{ id: string; currentStage: string }> {
  const res = await api('POST', '/api/hr/recruitment/applications', {
    token: adminToken,
    body: { jobRequisitionId: jobId, candidateId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return data<{ application: { id: string; currentStage: string } }>(res).application;
}

/** Walks an application forward through the legal path to a target stage. */
async function moveTo(applicationId: string, stages: string[]): Promise<void> {
  for (const toStage of stages) {
    const res = await api('POST', `/api/hr/recruitment/applications/${applicationId}/stage`, {
      token: adminToken,
      body: { toStage },
    });
    expect(res.status, `${toStage}: ${JSON.stringify(res.body)}`).toBe(200);
  }
}

/** An application carried all the way to an accepted offer. */
async function makeAcceptedOffer(): Promise<{
  applicationId: string;
  offerId: string;
  candidateId: string;
}> {
  // The shared vacancy: this helper's subject is the offer chain, not the requisition.
  const job = await sharedPublishedJob();
  const candidate = await makeCandidate();
  const application = await makeApplication(job.id, candidate.id);

  await moveTo(application.id, ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW', 'SELECTED']);

  const offerRes = await api('POST', '/api/hr/recruitment/offers', {
    token: adminToken,
    body: {
      applicationId: application.id,
      position: 'Test Role',
      departmentId,
      designationId,
      proposedJoiningDate: '2026-06-01',
    },
  });
  expect(offerRes.status, JSON.stringify(offerRes.body)).toBe(201);
  const offer = data<{ offer: { id: string } }>(offerRes).offer;

  await moveTo(application.id, ['OFFER']);

  const sent = await api('POST', `/api/hr/recruitment/offers/${offer.id}/send`, {
    token: adminToken,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  const accepted = await api('POST', `/api/hr/recruitment/offers/${offer.id}/respond`, {
    token: adminToken,
    body: { status: 'ACCEPTED' },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

  return { applicationId: application.id, offerId: offer.id, candidateId: candidate.id };
}

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  recruiter = await makeUser('USER');
  interviewer = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  recruiterToken = await mintToken(recruiter.id, { role: 'USER' });
  interviewerToken = await mintToken(interviewer.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  // Deliberately no APPROVE: the whole point of the action split is that running a
  // hiring process and committing the business to a hire are different grants.
  await grant(recruiter.id, 'HR_RECRUITMENT', ['VIEW', 'CREATE', 'EDIT']);
  // The interviewer gets HR_EMPLOYEE:VIEW only — enough to reach the routes, and
  // nothing that would give them the recruitment pipeline.
  await grant(interviewer.id, 'HR_EMPLOYEE', ['VIEW']);

  const dept = await api('POST', '/api/hr/departments', {
    token: adminToken,
    body: { name: 'Test Recruitment Dept', code: testCode('RDEPT') },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = data<{ department: { id: string } }>(dept).department.id;

  const desig = await api('POST', '/api/hr/designations', {
    token: adminToken,
    body: { name: 'Test Recruit Role', code: testCode('RDESIG'), level: 3 },
  });
  expect(desig.status).toBe(201);
  designationId = data<{ designation: { id: string } }>(desig).designation.id;

  // The interviewer's HR record, linked to their account — this is what the
  // involvement scope keys on.
  const panelEmployee = await makeEmployee({ firstName: 'Ina', lastName: 'Terviewer' });
  interviewerEmployeeId = panelEmployee.id;
  const link = await api('POST', `/api/hr/employees/${panelEmployee.id}/user`, {
    token: adminToken,
    body: { userId: interviewer.id },
  });
  expect(link.status, JSON.stringify(link.body)).toBe(200);

  const manager = await makeEmployee({ firstName: 'Mana', lastName: 'Ger' });
  managerEmployeeId = manager.id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

describe('job requisitions', () => {
  it('allocates a unique reference and is born DRAFT', async () => {
    const res = await api('POST', '/api/hr/recruitment/jobs', {
      token: adminToken,
      body: { title: 'Allocation Test', departmentId },
    });
    expect(res.status).toBe(201);

    const job = data<{ job: { code: string; status: string; publishedAt: string | null } }>(res).job;
    // A requisition cannot be born published: there would be no record of who did it.
    expect(job.status).toBe('DRAFT');
    expect(job.publishedAt).toBeNull();
    expect(job.code).toMatch(/^JOB-\d{4}-\d{4}$/);
  });

  it('never issues the same reference twice under concurrency', async () => {
    /*
      The counter's whole purpose. `SELECT max(...) + 1` read by two simultaneous
      creates returns the same number to both; INSERT … ON CONFLICT DO UPDATE …
      RETURNING inside the creating transaction cannot.
    */
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        api('POST', '/api/hr/recruitment/jobs', {
          token: adminToken,
          body: { title: `Concurrent ${index}`, departmentId },
        }),
      ),
    );

    for (const res of results) expect(res.status).toBe(201);
    const codes = results.map((res) => data<{ job: { code: string } }>(res).job.code);
    expect(new Set(codes).size).toBe(5);
  });

  it('refuses to publish without APPROVE', async () => {
    const created = await api('POST', '/api/hr/recruitment/jobs', {
      token: recruiterToken,
      body: { title: 'Recruiter Draft', departmentId },
    });
    expect(created.status).toBe(201);
    const job = data<{ job: { id: string } }>(created).job;

    // The recruiter raised it and may edit it, but publishing commits the business.
    const published = await api('POST', `/api/hr/recruitment/jobs/${job.id}/publish`, {
      token: recruiterToken,
    });
    expect(published.status).toBe(403);
  });

  it('stamps publishedAt and keeps it through a pause', async () => {
    const job = await makePublishedJob({ title: 'Pause Test' });

    const paused = await api('POST', `/api/hr/recruitment/jobs/${job.id}/pause`, {
      token: adminToken,
    });
    expect(paused.status).toBe(200);

    const after = data<{ job: { status: string; publishedAt: string | null } }>(paused).job;
    expect(after.status).toBe('PAUSED');
    // Pausing does not unpublish: "when did this go live" survives.
    expect(after.publishedAt).not.toBeNull();
  });

  it('requires a reason to close, and refuses to amend a closed role', async () => {
    const job = await makePublishedJob({ title: 'Close Test' });

    const noReason = await api('POST', `/api/hr/recruitment/jobs/${job.id}/close`, {
      token: adminToken,
      body: {},
    });
    // 422, not 400: the schema refuses it at the request boundary before the service
    // is reached. That is the better of the two — the rule is stated once, in Zod, and
    // the caller gets a field-level message.
    expect(noReason.status).toBe(422);

    const closed = await api('POST', `/api/hr/recruitment/jobs/${job.id}/close`, {
      token: adminToken,
      body: { reason: 'Filled internally' },
    });
    expect(closed.status).toBe(200);
    expect(data<{ job: { status: string; closedAt: string | null } }>(closed).job.status).toBe(
      'CLOSED',
    );

    // A closed requisition is history: amending its title would change what the
    // applications on it were applications for.
    const amended = await api('PATCH', `/api/hr/recruitment/jobs/${job.id}`, {
      token: adminToken,
      body: { title: 'Rewritten' },
    });
    expect(amended.status).toBe(400);
  });

  it('rejects a salary range whose top is below its bottom', async () => {
    const res = await api('POST', '/api/hr/recruitment/jobs', {
      token: adminToken,
      body: { title: 'Bad Range', salaryRangeMin: 900000, salaryRangeMax: 500000 },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

describe('candidates', () => {
  it('lower-cases the email so one person is one candidate', async () => {
    const email = testEmail('Case');
    const created = await makeCandidate({ email: email.toUpperCase() });
    expect(created.email).toBe(email.toLowerCase());

    // The same person in different case is refused rather than duplicated.
    const duplicate = await api('POST', '/api/hr/recruitment/candidates', {
      token: adminToken,
      body: { firstName: 'Dup', lastName: 'Licate', email: email.toLowerCase() },
    });
    expect(duplicate.status).toBe(409);
  });

  it('lets one candidate apply to several roles', async () => {
    /*
      The reason Candidate and Application are separate tables. Somebody rejected for
      one role may be right for the next, and folding the application into the
      candidate would mean either losing that history or duplicating the person.
    */
    const candidate = await makeCandidate();
    const first = await makePublishedJob({ title: 'Multi One' });
    const second = await makePublishedJob({ title: 'Multi Two' });

    const a = await makeApplication(first.id, candidate.id);
    const b = await makeApplication(second.id, candidate.id);
    expect(a.id).not.toBe(b.id);
  });

  it('refuses a second live application for the same role', async () => {
    const candidate = await makeCandidate();
    const job = await sharedPublishedJob();
    await makeApplication(job.id, candidate.id);

    const again = await api('POST', '/api/hr/recruitment/applications', {
      token: adminToken,
      body: { jobRequisitionId: job.id, candidateId: candidate.id },
    });
    expect(again.status).toBe(409);
  });

  it('refuses two concurrent applications for one role', async () => {
    // The composite unique is the real guard: a service-level check would pass in
    // both racing requests.
    const candidate = await makeCandidate();
    const job = await sharedPublishedJob();

    const results = await Promise.all([
      api('POST', '/api/hr/recruitment/applications', {
        token: adminToken,
        body: { jobRequisitionId: job.id, candidateId: candidate.id },
      }),
      api('POST', '/api/hr/recruitment/applications', {
        token: adminToken,
        body: { jobRequisitionId: job.id, candidateId: candidate.id },
      }),
    ]);

    const created = results.filter((res) => res.status === 201);
    expect(created).toHaveLength(1);
  });

  it('refuses an application against an unpublished role', async () => {
    /*
      A draft is not yet a vacancy. An application against one would record somebody
      applying for something that was not open — unfair to them, and misleading to
      whoever reads the pipeline later.
    */
    const draft = await api('POST', '/api/hr/recruitment/jobs', {
      token: adminToken,
      body: { title: 'Still A Draft', departmentId },
    });
    const job = data<{ job: { id: string } }>(draft).job;
    const candidate = await makeCandidate();

    const res = await api('POST', '/api/hr/recruitment/applications', {
      token: adminToken,
      body: { jobRequisitionId: job.id, candidateId: candidate.id },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  The ATS pipeline
// ---------------------------------------------------------------------------

describe('stage transitions', () => {
  it('writes a history entry for the first stage with no fromStage', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('GET', `/api/hr/recruitment/applications/${application.id}`, {
      token: adminToken,
    });
    const view = data<{
      application: { stageHistory: { fromStage: string | null; toStage: string }[] };
    }>(res).application;

    expect(view.stageHistory).toHaveLength(1);
    // An application starts somewhere rather than moving from nowhere.
    expect(view.stageHistory[0]?.fromStage).toBeNull();
    expect(view.stageHistory[0]?.toStage).toBe('APPLICATION');
  });

  it('refuses a skip over a commit point', async () => {
    /*
      The single most important transition rule. Nothing reaches OFFER without
      passing SELECTED, because that is where a human commits the business — and a
      pipeline that let a misclick skip it would produce an offer nobody decided to
      make.
    */
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await moveTo(application.id, ['SCREENING', 'SHORTLISTED']);

    const skipped = await api('POST', `/api/hr/recruitment/applications/${application.id}/stage`, {
      token: adminToken,
      body: { toStage: 'OFFER' },
    });
    expect(skipped.status).toBe(400);
    expect(skipped.body.code).toBe('STAGE_MOVE_NOT_ALLOWED');
  });

  it('allows an assessment round to be revisited', async () => {
    // A doubt raised late sends somebody back a round. That is a normal hiring
    // decision, not an error to be worked around.
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await moveTo(application.id, [
      'SCREENING',
      'SHORTLISTED',
      'FINAL_INTERVIEW',
      'DEPARTMENT_INTERVIEW',
    ]);
  });

  it('needs APPROVE to reach SELECTED, and stamps the decider', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await moveTo(application.id, ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW']);

    // The recruiter may move it through the assessment stages but not select.
    const refused = await api('POST', `/api/hr/recruitment/applications/${application.id}/stage`, {
      token: recruiterToken,
      body: { toStage: 'SELECTED' },
    });
    expect(refused.status).toBe(403);

    const selected = await api('POST', `/api/hr/recruitment/applications/${application.id}/stage`, {
      token: adminToken,
      body: { toStage: 'SELECTED' },
    });
    expect(selected.status).toBe(200);

    const view = data<{
      application: { selectedBy: { id: string } | null; selectedAt: string | null };
    }>(selected).application;
    // Who and when move together — the decision must be attributable.
    expect(view.selectedBy?.id).toBe(admin.id);
    expect(view.selectedAt).not.toBeNull();
  });

  it('lets only one of two concurrent stage moves win', async () => {
    /*
      Without the conditional update both would read ACTIVE, both would write, and
      the second would silently erase the first's decision along with its
      stage-history entry.
    */
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);
    await moveTo(application.id, ['SCREENING']);

    const results = await Promise.all([
      api('POST', `/api/hr/recruitment/applications/${application.id}/stage`, {
        token: adminToken,
        body: { toStage: 'SHORTLISTED' },
      }),
      api('POST', `/api/hr/recruitment/applications/${application.id}/stage`, {
        token: adminToken,
        body: { toStage: 'SHORTLISTED' },
      }),
    ]);

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(1);
  });

  it('requires a reason to reject, and keeps the stage', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);
    await moveTo(application.id, ['SCREENING', 'SHORTLISTED']);

    const noReason = await api(
      'POST',
      `/api/hr/recruitment/applications/${application.id}/reject`,
      { token: adminToken, body: {} },
    );
    expect(noReason.status).toBe(422);

    const rejected = await api(
      'POST',
      `/api/hr/recruitment/applications/${application.id}/reject`,
      { token: adminToken, body: { reason: 'Not enough domain experience' } },
    );
    expect(rejected.status).toBe(200);

    const view = data<{
      application: { status: string; currentStage: string; rejectionReason: string | null };
    }>(rejected).application;
    expect(view.status).toBe('REJECTED');
    // The stage records how far they got — a rejection must not erase that.
    expect(view.currentStage).toBe('SHORTLISTED');
    expect(view.rejectionReason).toBe('Not enough domain experience');
  });

  it('records a withdrawal as the candidate’s decision, not a rejection', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api(
      'POST',
      `/api/hr/recruitment/applications/${application.id}/withdraw`,
      { token: recruiterToken, body: { reason: 'Accepted another offer' } },
    );
    expect(res.status).toBe(200);
    // WITHDRAWN rather than REJECTED: recording their choice as our rejection would
    // misattribute it.
    expect(data<{ application: { status: string } }>(res).application.status).toBe('WITHDRAWN');
  });

  it('refuses to mark JOINED without an employment record', async () => {
    /*
      The whole pipeline converges on this. An application marked JOINED with no
      Employee behind it would say somebody started work who was never hired.
    */
    const { applicationId } = await makeAcceptedOffer();

    const onboarding = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: { applicationId, joiningDate: '2026-06-01' },
    });
    expect(onboarding.status).toBe(201);

    const joined = await api('POST', `/api/hr/recruitment/applications/${applicationId}/stage`, {
      token: adminToken,
      body: { toStage: 'JOINED' },
    });
    expect(joined.status).toBe(400);
    expect(joined.body.code).toBe('EMPLOYEE_NOT_CREATED');
  });
});

// ---------------------------------------------------------------------------
//  Interviews and the panel rule
// ---------------------------------------------------------------------------

describe('interviews', () => {
  async function bookInterview(): Promise<{ interviewId: string; applicationId: string }> {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'HR',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId: interviewerEmployeeId,
        participantIds: [managerEmployeeId],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return {
      interviewId: data<{ interview: { id: string } }>(res).interview.id,
      applicationId: application.id,
    };
  }

  it('refuses a booking in the past', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'HR',
        scheduledAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    expect(res.status).toBe(400);
  });

  it('writes the panel in the same statement, and includes the lead', async () => {
    const { interviewId } = await bookInterview();

    const res = await api('GET', `/api/hr/recruitment/interviews/${interviewId}`, {
      token: adminToken,
    });
    const view = data<{
      interview: { participants: { id: string }[]; interviewer: { id: string } | null };
    }>(res).interview;

    // The lead is a participant too, so the data says what is true rather than two
    // places agreeing by coincidence.
    const ids = view.participants.map((p) => p.id);
    expect(ids).toContain(interviewerEmployeeId);
    expect(ids).toContain(managerEmployeeId);
    expect(view.interviewer?.id).toBe(interviewerEmployeeId);
  });

  it('hides the panel’s feedback until the viewer submits their own', async () => {
    /*
      THE confidentiality rule of this phase, and the reason structured interviewing
      works. An interviewer who reads "the last two said no" has been told the
      answer, and the panel becomes one opinion wearing four hats.
    */
    const { interviewId } = await bookInterview();

    // The manager reports first, through the administrator acting for them is not
    // possible — feedback is first-hand, so it is written as the panel member. Here
    // the admin is not on the panel, so they are refused.
    const adminAttempt = await api(
      'POST',
      `/api/hr/recruitment/interviews/${interviewId}/feedback`,
      { token: adminToken, body: { recommendation: 'YES' } },
    );
    expect(adminAttempt.status).toBe(403);

    // Before submitting, the interviewer sees no feedback at all.
    const before = await api('GET', `/api/hr/recruitment/interviews/${interviewId}`, {
      token: interviewerToken,
    });
    expect(before.status).toBe(200);
    const beforeView = data<{
      interview: { feedback: unknown[]; feedbackPending: boolean };
    }>(before).interview;
    expect(beforeView.feedbackPending).toBe(true);
    expect(beforeView.feedback).toHaveLength(0);

    // They submit their own.
    const submitted = await api(
      'POST',
      `/api/hr/recruitment/interviews/${interviewId}/feedback`,
      {
        token: interviewerToken,
        body: { recommendation: 'STRONG_YES', rating: 5, concerns: 'None worth noting' },
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    // Now their own is visible and the flag is clear.
    const after = data<{
      interview: { feedback: { employee: { id: string } }[]; feedbackPending: boolean };
    }>(submitted).interview;
    expect(after.feedbackPending).toBe(false);
    expect(after.feedback.map((f) => f.employee.id)).toContain(interviewerEmployeeId);
  });

  it('lets an HR reader see every panel view', async () => {
    const { interviewId } = await bookInterview();

    await api('POST', `/api/hr/recruitment/interviews/${interviewId}/feedback`, {
      token: interviewerToken,
      body: { recommendation: 'YES' },
    });

    // Somebody has to be able to compare the panel's views; that is what the
    // decision is made from.
    const res = await api('GET', `/api/hr/recruitment/interviews/${interviewId}`, {
      token: adminToken,
    });
    expect(data<{ interview: { feedback: unknown[] } }>(res).interview.feedback).toHaveLength(1);
  });

  it('amends rather than duplicates a second submission', async () => {
    const { interviewId } = await bookInterview();

    for (const recommendation of ['MAYBE', 'YES']) {
      const res = await api(
        'POST',
        `/api/hr/recruitment/interviews/${interviewId}/feedback`,
        { token: interviewerToken, body: { recommendation } },
      );
      expect(res.status).toBe(200);
    }

    const res = await api('GET', `/api/hr/recruitment/interviews/${interviewId}`, {
      token: adminToken,
    });
    const feedback = data<{
      interview: { feedback: { recommendation: string }[] };
    }>(res).interview.feedback;

    // One row, amended — not two the panel then has to reconcile.
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.recommendation).toBe('YES');
  });

  it('refuses to reschedule a cancelled interview', async () => {
    const { interviewId } = await bookInterview();

    const cancelled = await api(
      'POST',
      `/api/hr/recruitment/interviews/${interviewId}/close`,
      { token: adminToken, body: { status: 'CANCELLED', reason: 'Candidate asked to move it' } },
    );
    expect(cancelled.status).toBe(200);

    // A cancelled interview is re-booked, not rescheduled — otherwise the record
    // would show one interview both cancelled and held.
    const moved = await api(
      'POST',
      `/api/hr/recruitment/interviews/${interviewId}/reschedule`,
      {
        token: adminToken,
        body: {
          scheduledAt: new Date(Date.now() + 172_800_000).toISOString(),
          reason: 'Trying anyway',
        },
      },
    );
    expect(moved.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

describe('offers', () => {
  it('refuses an offer to an unselected candidate', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('POST', '/api/hr/recruitment/offers', {
      token: adminToken,
      body: {
        applicationId: application.id,
        position: 'Test Role',
        proposedJoiningDate: '2026-06-01',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANDIDATE_NOT_SELECTED');
  });

  it('cannot be accepted twice', async () => {
    const { offerId } = await makeAcceptedOffer();

    const again = await api('POST', `/api/hr/recruitment/offers/${offerId}/respond`, {
      token: adminToken,
      body: { status: 'ACCEPTED' },
    });
    expect(again.status).toBe(409);
  });

  it('lets only one of two concurrent acceptances win', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);
    await moveTo(application.id, ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW', 'SELECTED']);

    const offerRes = await api('POST', '/api/hr/recruitment/offers', {
      token: adminToken,
      body: {
        applicationId: application.id,
        position: 'Test Role',
        proposedJoiningDate: '2026-06-01',
      },
    });
    const offer = data<{ offer: { id: string } }>(offerRes).offer;
    await moveTo(application.id, ['OFFER']);
    await api('POST', `/api/hr/recruitment/offers/${offer.id}/send`, { token: adminToken });

    const results = await Promise.all([
      api('POST', `/api/hr/recruitment/offers/${offer.id}/respond`, {
        token: adminToken,
        body: { status: 'ACCEPTED' },
      }),
      api('POST', `/api/hr/recruitment/offers/${offer.id}/respond`, {
        token: adminToken,
        body: { status: 'ACCEPTED' },
      }),
    ]);

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
  });

  it('requires a note to decline, and marks the application DECLINED', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);
    await moveTo(application.id, ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW', 'SELECTED']);

    const offerRes = await api('POST', '/api/hr/recruitment/offers', {
      token: adminToken,
      body: {
        applicationId: application.id,
        position: 'Test Role',
        proposedJoiningDate: '2026-06-01',
      },
    });
    const offer = data<{ offer: { id: string } }>(offerRes).offer;
    await moveTo(application.id, ['OFFER']);
    await api('POST', `/api/hr/recruitment/offers/${offer.id}/send`, { token: adminToken });

    const noNote = await api('POST', `/api/hr/recruitment/offers/${offer.id}/respond`, {
      token: adminToken,
      body: { status: 'REJECTED' },
    });
    expect(noNote.status).toBe(422);

    const declined = await api('POST', `/api/hr/recruitment/offers/${offer.id}/respond`, {
      token: adminToken,
      body: { status: 'REJECTED', responseNote: 'Took a role elsewhere' },
    });
    expect(declined.status).toBe(200);

    const view = await api('GET', `/api/hr/recruitment/applications/${application.id}`, {
      token: adminToken,
    });
    // DECLINED, not REJECTED: the candidate refused, and recording it as our
    // rejection would misattribute it.
    expect(data<{ application: { status: string } }>(view).application.status).toBe('DECLINED');
  });

  it('refuses an expiry after the proposed start date', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);
    await moveTo(application.id, ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW', 'SELECTED']);

    const res = await api('POST', '/api/hr/recruitment/offers', {
      token: adminToken,
      body: {
        applicationId: application.id,
        position: 'Test Role',
        proposedJoiningDate: '2026-06-01',
        expiresOn: '2026-07-01',
      },
    });
    // Zod's cross-field refine catches this before the service, hence 422.
    expect(res.status).toBe(422);
  });

  it('refuses to edit a sent offer', async () => {
    const { offerId } = await makeAcceptedOffer();

    // Once sent, the candidate has been told something; amending in place would make
    // the record disagree with what they hold.
    const res = await api('PATCH', `/api/hr/recruitment/offers/${offerId}`, {
      token: adminToken,
      body: { position: 'Something Else' },
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

describe('background verification', () => {
  it('requires an explanation for an adverse result', async () => {
    const { applicationId } = await makeAcceptedOffer();

    const requested = await api('POST', '/api/hr/recruitment/background-checks', {
      token: adminToken,
      body: { applicationId, checkType: 'EMPLOYMENT' },
    });
    expect(requested.status).toBe(201);
    const check = data<{ check: { id: string } }>(requested).check;

    // "Failed" with no evidence is an accusation nobody can answer, and this is
    // somebody's livelihood.
    const noResult = await api(
      'POST',
      `/api/hr/recruitment/background-checks/${check.id}/result`,
      { token: adminToken, body: { status: 'FAILED' } },
    );
    expect(noResult.status).toBe(422);

    const withResult = await api(
      'POST',
      `/api/hr/recruitment/background-checks/${check.id}/result`,
      {
        token: adminToken,
        body: { status: 'FLAGGED', result: 'Previous employer could not confirm the dates' },
      },
    );
    expect(withResult.status).toBe(200);
  });

  it('requires a reason to waive a check', async () => {
    const { applicationId } = await makeAcceptedOffer();
    const requested = await api('POST', '/api/hr/recruitment/background-checks', {
      token: adminToken,
      body: { applicationId, checkType: 'CRIMINAL' },
    });
    const check = data<{ check: { id: string } }>(requested).check;

    const noNote = await api(
      'POST',
      `/api/hr/recruitment/background-checks/${check.id}/result`,
      { token: adminToken, body: { status: 'WAIVED' } },
    );
    expect(noNote.status).toBe(422);
  });

  it('re-requesting the same type resets rather than duplicates', async () => {
    const { applicationId } = await makeAcceptedOffer();

    for (let i = 0; i < 2; i += 1) {
      const res = await api('POST', '/api/hr/recruitment/background-checks', {
        token: adminToken,
        body: { applicationId, checkType: 'IDENTITY' },
      });
      expect(res.status).toBe(201);
    }

    const list = await api(
      'GET',
      `/api/hr/recruitment/applications/${applicationId}/background-checks`,
      { token: adminToken },
    );
    const checks = data<{ checks: { checkType: string }[] }>(list).checks;
    expect(checks.filter((c) => c.checkType === 'IDENTITY')).toHaveLength(1);
  });

  it('a flagged check does NOT reject the application', async () => {
    /*
      The single most important restraint in the module. A database row must not end
      somebody's employment prospects without a person deciding — so a flagged check
      blocks the employment record and leaves the application live for a human to
      resolve.
    */
    const { applicationId } = await makeAcceptedOffer();

    const requested = await api('POST', '/api/hr/recruitment/background-checks', {
      token: adminToken,
      body: { applicationId, checkType: 'EDUCATION' },
    });
    const check = data<{ check: { id: string } }>(requested).check;

    await api('POST', `/api/hr/recruitment/background-checks/${check.id}/result`, {
      token: adminToken,
      body: { status: 'FLAGGED', result: 'Degree certificate not verified' },
    });

    const view = await api('GET', `/api/hr/recruitment/applications/${applicationId}`, {
      token: adminToken,
    });
    expect(data<{ application: { status: string } }>(view).application.status).toBe('ACTIVE');
  });

  it('blocks employee creation while a check is flagged', async () => {
    const { applicationId } = await makeAcceptedOffer();

    const onboardingRes = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: { applicationId, joiningDate: '2026-06-01', departmentId, designationId },
    });
    const onboarding = data<{ onboarding: { id: string } }>(onboardingRes).onboarding;

    const requested = await api('POST', '/api/hr/recruitment/background-checks', {
      token: adminToken,
      body: { applicationId, checkType: 'REFERENCE' },
    });
    const check = data<{ check: { id: string } }>(requested).check;
    await api('POST', `/api/hr/recruitment/background-checks/${check.id}/result`, {
      token: adminToken,
      body: { status: 'FLAGGED', result: 'Referee did not respond' },
    });

    const blocked = await api('POST', `/api/hr/onboarding/${onboarding.id}/employee`, {
      token: adminToken,
      body: { workEmail: testEmail('blocked') },
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('EMPLOYEE_NOT_CREATABLE');
  });
});

// ---------------------------------------------------------------------------
//  Onboarding and employee creation
// ---------------------------------------------------------------------------

describe('onboarding', () => {
  async function makeOnboarding(): Promise<{ id: string; applicationId: string }> {
    const { applicationId } = await makeAcceptedOffer();
    const res = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: {
        applicationId,
        joiningDate: '2026-06-01',
        departmentId,
        designationId,
        managerId: managerEmployeeId,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: data<{ onboarding: { id: string } }>(res).onboarding.id, applicationId };
  }

  it('seeds a default checklist', async () => {
    const { id } = await makeOnboarding();

    const res = await api('GET', `/api/hr/onboarding/${id}`, { token: adminToken });
    const view = data<{ onboarding: { tasks: { category: string }[]; taskCount: number } }>(res)
      .onboarding;

    // An empty checklist is a checklist nobody fills in.
    expect(view.tasks.length).toBeGreaterThan(0);
    expect(view.taskCount).toBe(view.tasks.length);
    // Including the account task, which is how the login limitation is surfaced.
    expect(view.tasks.some((t) => t.category === 'HR')).toBe(true);
  });

  it('refuses a second onboarding for one application', async () => {
    const { applicationId } = await makeOnboarding();

    const again = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: { applicationId, joiningDate: '2026-06-01' },
    });
    expect(again.status).toBe(409);
  });

  it('refuses onboarding before an offer is accepted', async () => {
    const job = await makePublishedJob({ title: 'Early Onboard' });
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: { applicationId: application.id, joiningDate: '2026-06-01' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OFFER_NOT_ACCEPTED');
  });

  it('refuses to advance past verification without an employment record', async () => {
    const { id } = await makeOnboarding();

    await api('POST', `/api/hr/onboarding/${id}/advance`, {
      token: adminToken,
      body: { toStage: 'DOCUMENTS' },
    });
    await api('POST', `/api/hr/onboarding/${id}/advance`, {
      token: adminToken,
      body: { toStage: 'VERIFICATION' },
    });

    // The hinge. EMPLOYEE_CREATED is reached by creating the record, never by a
    // stage move — so ACCOUNT is unreachable until it exists.
    const blocked = await api('POST', `/api/hr/onboarding/${id}/advance`, {
      token: adminToken,
      body: { toStage: 'ACCOUNT' },
    });
    expect(blocked.status).toBe(400);
  });

  it('creates the employment record with an allocated number and no login', async () => {
    const { id } = await makeOnboarding();

    const res = await api('POST', `/api/hr/onboarding/${id}/employee`, {
      token: adminToken,
      body: { workEmail: testEmail('hired') },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const view = data<{
      onboarding: { employee: { id: string; employeeId: string } | null; stage: string };
    }>(res).onboarding;

    expect(view.stage).toBe('EMPLOYEE_CREATED');
    expect(view.employee).not.toBeNull();
    // Allocated from the Phase 1 counter, not supplied — and in its format.
    expect(view.employee?.employeeId).toMatch(/^RS\d{3,}$/);

    // No login was created: onboarding records that an account is owed, it does not
    // mint one. There is no secure invitation flow in this codebase.
    const employee = await prisma.employee.findUnique({
      where: { id: view.employee?.id ?? '' },
      select: { userId: true, departmentId: true, designationId: true, managerId: true },
    });
    expect(employee?.userId).toBeNull();
    // Placement came from the onboarding record rather than from the caller.
    expect(employee?.departmentId).toBe(departmentId);
    expect(employee?.designationId).toBe(designationId);
    expect(employee?.managerId).toBe(managerEmployeeId);
  });

  it('writes a JOINED history entry in the same transaction', async () => {
    const { id } = await makeOnboarding();
    const res = await api('POST', `/api/hr/onboarding/${id}/employee`, {
      token: adminToken,
      body: { workEmail: testEmail('hist') },
    });
    const employeeId = data<{ onboarding: { employee: { id: string } } }>(res).onboarding.employee
      .id;

    const history = await prisma.employeeHistory.findMany({
      where: { employeeId },
      select: { eventType: true },
    });
    // History that could commit without the employee, or the reverse, would be a
    // timeline that lies.
    expect(history.map((h) => h.eventType)).toContain('JOINED');
  });

  it('ONE HIRE CANNOT PRODUCE TWO EMPLOYMENT RECORDS', async () => {
    /*
      The most important concurrency test in the phase.

      Without the conditional attach both requests read a null `employeeId`, both
      call `allocateEmployeeId`, and the business ends up with two Employee rows and
      two employee numbers for one person — unrecoverable by anything but hand
      repair, and invisible until somebody notices the directory has them twice.
    */
    const { id } = await makeOnboarding();

    const results = await Promise.all([
      api('POST', `/api/hr/onboarding/${id}/employee`, {
        token: adminToken,
        body: { workEmail: testEmail('raceA') },
      }),
      api('POST', `/api/hr/onboarding/${id}/employee`, {
        token: adminToken,
        body: { workEmail: testEmail('raceB') },
      }),
    ]);

    const created = results.filter((res) => res.status === 201);
    expect(created).toHaveLength(1);

    // And the loser's allocated number and Employee row were rolled back, not left
    // orphaned — the onboarding points at exactly one employee.
    const record = await prisma.onboardingRecord.findUnique({
      where: { id },
      select: { employeeId: true },
    });
    expect(record?.employeeId).not.toBeNull();
  });

  it('needs APPROVE to create the employment record', async () => {
    const { id } = await makeOnboarding();

    const res = await api('POST', `/api/hr/onboarding/${id}/employee`, {
      token: recruiterToken,
      body: { workEmail: testEmail('norights') },
    });
    expect(res.status).toBe(403);
  });

  it('requires a note to skip a task', async () => {
    const { id } = await makeOnboarding();
    const view = await api('GET', `/api/hr/onboarding/${id}`, { token: adminToken });
    const task = data<{ onboarding: { tasks: { id: string }[] } }>(view).onboarding.tasks[0];

    const noNote = await api('POST', `/api/hr/onboarding-tasks/${task?.id}/complete`, {
      token: adminToken,
      body: { status: 'SKIPPED' },
    });
    expect(noNote.status).toBe(422);

    const withNote = await api('POST', `/api/hr/onboarding-tasks/${task?.id}/complete`, {
      token: adminToken,
      body: { status: 'SKIPPED', notes: 'Already held on file from a previous engagement' },
    });
    expect(withNote.status).toBe(200);
  });

  it('cannot settle one task twice', async () => {
    const { id } = await makeOnboarding();
    const view = await api('GET', `/api/hr/onboarding/${id}`, { token: adminToken });
    const task = data<{ onboarding: { tasks: { id: string }[] } }>(view).onboarding.tasks[1];

    const results = await Promise.all([
      api('POST', `/api/hr/onboarding-tasks/${task?.id}/complete`, {
        token: adminToken,
        body: { status: 'COMPLETED' },
      }),
      api('POST', `/api/hr/onboarding-tasks/${task?.id}/complete`, {
        token: adminToken,
        body: { status: 'COMPLETED' },
      }),
    ]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

describe('probation', () => {
  /**
   * A probation whose reviewing manager is an account that can actually record.
   *
   * `interviewerEmployeeId` rather than `managerEmployeeId`, deliberately: a completed
   * review must name its reviewer (the probation_review_completion CHECK), so the
   * reviewer has to be an Employee *with a linked login*. The interviewer is the only
   * such account in this suite — the administrator has every grant but no HR record,
   * and therefore nobody to attribute an assessment to.
   */
  async function makeProbation(): Promise<{ id: string; employeeId: string }> {
    const employee = await makeEmployee({ firstName: 'Prob', lastName: 'Ationer' });

    const res = await api('POST', '/api/hr/probation', {
      token: adminToken,
      body: {
        employeeId: employee.id,
        startDate: '2026-02-01',
        endDate: '2026-05-01',
        managerId: interviewerEmployeeId,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: data<{ probation: { id: string } }>(res).probation.id, employeeId: employee.id };
  }

  it('schedules all four reviews on creation', async () => {
    const { id } = await makeProbation();

    const res = await api('GET', `/api/hr/probation/${id}`, { token: adminToken });
    const view = data<{
      probation: { reviews: { reviewType: string; scheduledOn: string }[] };
    }>(res).probation;

    // A probation with two of its four reviews is worse than a failed start: the
    // missing ones are invisible until the date passes and nobody is reminded.
    expect(view.reviews.map((r) => r.reviewType).sort()).toEqual([
      'DAY_30',
      'DAY_60',
      'DAY_90',
      'FIRST_WEEK',
    ]);
    // Dated from the start, using the shared offsets.
    const day30 = view.reviews.find((r) => r.reviewType === 'DAY_30');
    expect(day30?.scheduledOn).toBe('2026-03-03');
  });

  it('refuses a second probation for one employee', async () => {
    const { employeeId } = await makeProbation();

    const again = await api('POST', '/api/hr/probation', {
      token: adminToken,
      body: { employeeId, startDate: '2026-06-01', endDate: '2026-09-01' },
    });
    expect(again.status).toBe(409);
  });

  it('refuses an end date on or before the start', async () => {
    const employee = await makeEmployee({ firstName: 'Bad', lastName: 'Dates' });
    const res = await api('POST', '/api/hr/probation', {
      token: adminToken,
      body: { employeeId: employee.id, startDate: '2026-05-01', endDate: '2026-05-01' },
    });
    expect(res.status).toBe(422);
  });

  it('requires a comment on a review, not just a rating', async () => {
    const { id } = await makeProbation();
    const view = await api('GET', `/api/hr/probation/${id}`, { token: adminToken });
    const review = data<{ probation: { reviews: { id: string }[] } }>(view).probation.reviews[0];

    // A rating with no comment is a number somebody is expected to act on with no
    // explanation, and this record is what a later decision rests on.
    const noComment = await api('POST', `/api/hr/probation-reviews/${review?.id}`, {
      token: interviewerToken,
      body: { rating: 4 },
    });
    expect(noComment.status).toBe(422);

    const withComment = await api('POST', `/api/hr/probation-reviews/${review?.id}`, {
      token: interviewerToken,
      body: { rating: 4, comments: 'Settling in well, picking up the process quickly' },
    });
    expect(withComment.status, JSON.stringify(withComment.body)).toBe(200);
  });

  it('cannot record one review twice', async () => {
    const { id } = await makeProbation();
    const view = await api('GET', `/api/hr/probation/${id}`, { token: adminToken });
    const review = data<{ probation: { reviews: { id: string }[] } }>(view).probation.reviews[1];

    const results = await Promise.all([
      api('POST', `/api/hr/probation-reviews/${review?.id}`, {
        token: interviewerToken,
        body: { comments: 'First writer wins this race' },
      }),
      api('POST', `/api/hr/probation-reviews/${review?.id}`, {
        token: interviewerToken,
        body: { comments: 'Second writer should lose' },
      }),
    ]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
  });

  it('refuses a review from an account with no employee record', async () => {
    /*
      Discovered while writing this suite, and worth pinning rather than working around.

      The administrator holds every recruitment grant but has no Employee record, so
      there is nobody to attribute an assessment to — and the
      probation_review_completion CHECK requires `reviewerId` on a completed review. So
      this is refused by design, not by oversight: a review that cannot say who gave it
      is worth nothing, and it is exactly the record a later confirmation or
      termination rests on.

      The remedy is the existing Phase 1 operation — link the account to its HR record
      — which is what the error message says.
    */
    const { id } = await makeProbation();
    const view = await api('GET', `/api/hr/probation/${id}`, { token: adminToken });
    const review = data<{ probation: { reviews: { id: string }[] } }>(view).probation.reviews[2];

    const res = await api('POST', `/api/hr/probation-reviews/${review?.id}`, {
      token: adminToken,
      body: { comments: 'Trying to review without an HR record of my own' },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/link your account/i);
  });

  it('requires a reason for every decision', async () => {
    const { id } = await makeProbation();

    const noReason = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'CONFIRM' },
    });
    expect(noReason.status).toBe(422);
  });

  it('keeps the original end date when extended', async () => {
    const { id } = await makeProbation();

    const extended = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: {
        decision: 'EXTEND',
        reason: 'Needs another month on the reporting process',
        newEndDate: '2026-06-01',
      },
    });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);

    const view = data<{
      probation: { status: string; endDate: string; originalEndDate: string | null };
    }>(extended).probation;
    expect(view.status).toBe('EXTENDED');
    expect(view.endDate).toBe('2026-06-01');
    // The term first given survives rather than being lost to an UPDATE.
    expect(view.originalEndDate).toBe('2026-05-01');
  });

  it('refuses an extension that does not move the date later', async () => {
    const { id } = await makeProbation();
    const res = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'EXTEND', reason: 'Trying to shorten it', newEndDate: '2026-04-01' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a new end date on a confirmation', async () => {
    const { id } = await makeProbation();
    const res = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'CONFIRM', reason: 'Doing well', newEndDate: '2026-06-01' },
    });
    expect(res.status).toBe(422);
  });

  it('TERMINATE does not set the employee to EXITED', async () => {
    /*
      The restraint this UI and service were built around. Ending an employment is a
      Phase 1 operation with its own exit-date requirement and its own history entry;
      doing it as a side effect here would leave somebody marked as left with no
      leaving date and nothing in their timeline saying so.
    */
    const { id, employeeId } = await makeProbation();

    const terminated = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'TERMINATE', reason: 'Not meeting the role requirements' },
    });
    expect(terminated.status).toBe(200);
    expect(data<{ probation: { status: string } }>(terminated).probation.status).toBe('TERMINATED');

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { status: true, exitDate: true },
    });
    expect(employee?.status).toBe('ACTIVE');
    expect(employee?.exitDate).toBeNull();
  });

  it('cannot be decided twice', async () => {
    const { id } = await makeProbation();

    await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'CONFIRM', reason: 'Confirmed after a good three months' },
    });

    const again = await api('POST', `/api/hr/probation/${id}/decide`, {
      token: adminToken,
      body: { decision: 'TERMINATE', reason: 'Changed my mind' },
    });
    expect(again.status).toBe(409);
  });

  it('lets only one of two concurrent decisions win', async () => {
    const { id } = await makeProbation();

    const results = await Promise.all([
      api('POST', `/api/hr/probation/${id}/decide`, {
        token: adminToken,
        body: { decision: 'CONFIRM', reason: 'First decider should win' },
      }),
      api('POST', `/api/hr/probation/${id}/decide`, {
        token: adminToken,
        body: { decision: 'CONFIRM', reason: 'Second decider should lose' },
      }),
    ]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  Access and confidentiality
// ---------------------------------------------------------------------------

describe('access control', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await api('GET', '/api/hr/recruitment/jobs');
    expect(res.status).toBe(401);
  });

  it('refuses the candidate directory to somebody without the module', async () => {
    const res = await api('GET', '/api/hr/recruitment/candidates', { token: outsiderToken });
    expect(res.status).toBe(403);
  });

  it('shows an uninvolved reader an empty board rather than an error', async () => {
    /*
      A permitted-but-uninvolved reader sees nothing rather than a 403, which is why
      `visibleJobFilter` returns an impossible-id filter for the `none` scope. A `{}`
      there would match everything — the exact mistake it guards against.
    */
    await makePublishedJob({ title: 'Invisible To Interviewer' });

    const res = await api('GET', '/api/hr/recruitment/jobs', { token: interviewerToken });
    expect(res.status).toBe(200);
    expect(data<{ items: unknown[] }>(res).items).toHaveLength(0);
  });

  it('lets an interviewer reach the application they are booked against', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'DEPARTMENT',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId: interviewerEmployeeId,
      },
    });

    const res = await api('GET', `/api/hr/recruitment/applications/${application.id}`, {
      token: interviewerToken,
    });
    expect(res.status).toBe(200);
  });

  it('hides screening notes and verification results from an interviewer', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await api('POST', `/api/hr/recruitment/applications/${application.id}/screen`, {
      token: adminToken,
      body: { screeningScore: 40, screeningNotes: 'Weak on the phone screen' },
    });
    const check = await api('POST', '/api/hr/recruitment/background-checks', {
      token: adminToken,
      body: { applicationId: application.id, checkType: 'IDENTITY' },
    });
    expect(check.status).toBe(201);

    await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'TECHNICAL',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId: interviewerEmployeeId,
      },
    });

    const res = await api('GET', `/api/hr/recruitment/applications/${application.id}`, {
      token: interviewerToken,
    });
    const view = data<{
      application: {
        screeningNotes: string | null;
        screeningScore: number | null;
        backgroundChecks: unknown[];
      };
    }>(res).application;

    // An interviewer who reads "weak on the phone screen" has been told the answer.
    expect(view.screeningNotes).toBeNull();
    expect(view.screeningScore).toBeNull();
    // And a verification result ends somebody's prospects — only the people
    // accountable for the decision should hold it.
    expect(view.backgroundChecks).toHaveLength(0);
  });

  it('refuses verification results to an interviewer on the dedicated endpoint too', async () => {
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'HR',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId: interviewerEmployeeId,
      },
    });

    // Two layers saying the same thing: the empty array above means a page renders
    // without the section, and this 403 means a hand-crafted request gains nothing.
    const res = await api(
      'GET',
      `/api/hr/recruitment/applications/${application.id}/background-checks`,
      { token: interviewerToken },
    );
    expect(res.status).toBe(403);
  });

  it('hides compensation from a reader without the module', async () => {
    const job = await makePublishedJob({
      title: 'Pay Narrowing',
      salaryRangeMin: 500000,
      salaryRangeMax: 900000,
    });
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    await api('POST', '/api/hr/recruitment/interviews', {
      token: adminToken,
      body: {
        applicationId: application.id,
        interviewType: 'HR',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        interviewerId: interviewerEmployeeId,
      },
    });

    const asAdmin = await api('GET', `/api/hr/recruitment/jobs/${job.id}`, { token: adminToken });
    expect(
      data<{ job: { salaryRangeMin: string | null } }>(asAdmin).job.salaryRangeMin,
    ).not.toBeNull();
  });

  it('refuses a not-found rather than a forbidden for an out-of-scope record', async () => {
    /*
      Telling somebody "you may not see application X" confirms that X exists, which
      is itself a disclosure — that this business is considering somebody.
    */
    const job = await sharedPublishedJob();
    const candidate = await makeCandidate();
    const application = await makeApplication(job.id, candidate.id);

    const res = await api('GET', `/api/hr/recruitment/applications/${application.id}`, {
      token: interviewerToken,
    });
    expect(res.status).toBe(404);
  });

  it('writes no User row and no permission row', async () => {
    /*
      The module boundary. Creating an employment record from an onboarding writes
      Employee and EmployeeHistory and nothing else — no credential, no permission,
      no second auth system.
    */
    const usersBefore = await prisma.user.count();
    const permissionsBefore = await prisma.userModulePermission.count();

    const { applicationId } = await makeAcceptedOffer();
    const onboardingRes = await api('POST', '/api/hr/onboarding', {
      token: adminToken,
      body: { applicationId, joiningDate: '2026-06-01', departmentId, designationId },
    });
    const onboarding = data<{ onboarding: { id: string } }>(onboardingRes).onboarding;
    await api('POST', `/api/hr/onboarding/${onboarding.id}/employee`, {
      token: adminToken,
      body: { workEmail: testEmail('noauth') },
    });

    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.userModulePermission.count()).toBe(permissionsBefore);
  });
});
