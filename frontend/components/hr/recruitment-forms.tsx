'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  BACKGROUND_CHECK_TYPES,
  CANDIDATE_SOURCES,
  EMPLOYMENT_TYPES,
  INTERVIEW_TYPES,
  JOB_PRIORITIES,
  WORK_MODES,
  type ApplicationSummary,
  type CandidateSummary,
  type JobRequisitionSummary,
  type OrgUnitRef,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  createApplicationAction,
  createCandidateAction,
  createJobAction,
  createOfferAction,
  createOnboardingAction,
  requestBackgroundCheckAction,
  scheduleInterviewAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  BACKGROUND_CHECK_TYPE_LABELS,
  CANDIDATE_SOURCE_LABELS,
  INTERVIEW_TYPE_LABELS,
  JOB_PRIORITY_LABELS,
} from './recruitment-labels';
import { EMPLOYMENT_TYPE_LABELS, WORK_MODE_LABELS } from './hr-labels';

/**
 * The Phase 3 creation forms.
 *
 * All of them share one shape, and it is deliberate: validate the obvious things so the
 * person is told before submitting, then send and relay whatever the server says. Every
 * client check here is mirrored by Zod and most by a database CHECK, and **those are the
 * ones that decide**. A form that passed its own validation and was then refused is
 * annoying; a form that passed its own validation and was accepted when it should not
 * have been is a defect.
 *
 * None of these computes a business value. No code is generated (the server allocates
 * references from an atomic counter), no stage is chosen (a record is born at its
 * starting stage), no status is set, and no employee number appears anywhere.
 */

type Field = { path: string; message: string };

function errorsFrom(details: Field[] | undefined): Record<string, string> {
  return Object.fromEntries((details ?? []).map((d) => [d.path, d.message]));
}

// ---------------------------------------------------------------------------
//  Job requisition
// ---------------------------------------------------------------------------

/**
 * Raising a requisition.
 *
 * No `code` field and no `status` field. The reference is allocated server-side inside
 * the creating transaction — a client-supplied one is a duplicate waiting to happen, and
 * it is quoted in correspondence. The requisition is born DRAFT; publishing is a separate
 * act so it carries a timestamp and an audit entry naming whoever did it.
 */
export function CreateJobForm({
  departments,
  designations,
}: {
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const title = text('title');
    if (!title || title.length < 2) {
      setFieldErrors({ title: 'Name the role' });
      return;
    }

    const min = text('salaryRangeMin');
    const max = text('salaryRangeMax');
    if (min && max && Number(max) < Number(min)) {
      setFieldErrors({ salaryRangeMax: 'The top of the range cannot be below the bottom' });
      return;
    }

    const openings = text('openings');
    const targetJoinDate = text('targetJoinDate');

    startTransition(async () => {
      const result = await createJobAction({
        title,
        departmentId: text('departmentId'),
        designationId: text('designationId'),
        employmentType: text('employmentType'),
        workMode: text('workMode'),
        location: text('location'),
        openings: openings ? Number(openings) : undefined,
        description: text('description'),
        requirements: text('requirements'),
        responsibilities: text('responsibilities'),
        salaryRangeMin: min ? Number(min) : undefined,
        salaryRangeMax: max ? Number(max) : undefined,
        priority: text('priority'),
        targetJoinDate: targetJoinDate ? `${targetJoinDate}T00:00:00.000Z` : undefined,
      });

      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      router.push(`/hr/recruitment/jobs/${result.data.job.id}`);
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="title"
            label="Role title"
            required
            error={fieldErrors.title}
            placeholder="Senior Operations Executive"
          />
          <SelectField
            name="priority"
            label="Priority"
            options={JOB_PRIORITIES.map((p) => ({ value: p, label: JOB_PRIORITY_LABELS[p] }))}
            placeholder="Normal"
          />
          <SelectField
            name="departmentId"
            label="Department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="designationId"
            label="Designation"
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="employmentType"
            label="Employment type"
            options={EMPLOYMENT_TYPES.map((t) => ({
              value: t,
              label: EMPLOYMENT_TYPE_LABELS[t],
            }))}
            placeholder="Full time"
          />
          <SelectField
            name="workMode"
            label="Work mode"
            options={WORK_MODES.map((m) => ({ value: m, label: WORK_MODE_LABELS[m] }))}
            placeholder="On site"
          />
          <TextField name="location" label="Location" />
          <TextField name="openings" label="Openings" type="number" placeholder="1" />
          <TextField name="targetJoinDate" label="Target joining date" type="date" />
        </div>

        {/*
          Informational only. Phase 3 computes nothing from these and there is no payroll
          anywhere in the module — a range exists so a recruiter can record what was
          advertised, and nothing more.
        */}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="salaryRangeMin"
            label="Advertised range — from"
            type="number"
            error={fieldErrors.salaryRangeMin}
          />
          <TextField
            name="salaryRangeMax"
            label="Advertised range — to"
            type="number"
            error={fieldErrors.salaryRangeMax}
          />
        </div>

        <AreaField name="description" label="About the role" />
        <AreaField name="requirements" label="Requirements" />
        <AreaField name="responsibilities" label="Responsibilities" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Create requisition'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Candidate
// ---------------------------------------------------------------------------

/**
 * Adding a candidate.
 *
 * The email is the identity key: one person is one candidate however many roles they
 * apply for, which is what the unique index on it buys. When it collides the server says
 * so by name rather than returning a raw constraint error — "add an application to them
 * instead" is the useful answer.
 */
export function CreateCandidateForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const firstName = text('firstName');
    const lastName = text('lastName');
    const email = text('email');

    if (!firstName) {
      setFieldErrors({ firstName: 'A first name is needed' });
      return;
    }
    if (!lastName) {
      setFieldErrors({ lastName: 'A last name is needed' });
      return;
    }
    if (!email || !email.includes('@')) {
      setFieldErrors({ email: 'Enter a valid email address' });
      return;
    }

    const skillsRaw = text('skills');
    const experience = text('totalExperienceYears');

    startTransition(async () => {
      const result = await createCandidateAction({
        firstName,
        lastName,
        email,
        phone: text('phone'),
        location: text('location'),
        source: text('source'),
        sourceDetail: text('sourceDetail'),
        currentEmployer: text('currentEmployer'),
        currentDesignation: text('currentDesignation'),
        totalExperienceYears: experience ? Number(experience) : undefined,
        // Comma-separated in the form, an array on the wire. A chip input would be a
        // nicer control and is not worth a dependency for a field read as a whole.
        skills: skillsRaw
          ? skillsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        notes: text('notes'),
      });

      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      setOpen(false);
      router.push(`/hr/recruitment/candidates/${result.data.candidate.id}`);
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Add candidate
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Add a candidate
      </h3>

      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="firstName" label="First name" required error={fieldErrors.firstName} />
          <TextField name="lastName" label="Last name" required error={fieldErrors.lastName} />
          <TextField name="email" label="Email" type="email" required error={fieldErrors.email} />
          <TextField name="phone" label="Phone" />
          <TextField name="location" label="Location" />
          <SelectField
            name="source"
            label="How we found them"
            options={CANDIDATE_SOURCES.map((s) => ({
              value: s,
              label: CANDIDATE_SOURCE_LABELS[s],
            }))}
            placeholder="Direct"
          />
          <TextField name="sourceDetail" label="Referred by / source detail" />
          <TextField
            name="totalExperienceYears"
            label="Years of experience"
            type="number"
            step="0.5"
          />
          <TextField name="currentEmployer" label="Current employer" />
          <TextField name="currentDesignation" label="Current role" />
        </div>

        <TextField name="skills" label="Skills" placeholder="Comma separated" />

        {/* Internal. There is no candidate-facing route in this application at all. */}
        <AreaField name="notes" label="Internal notes" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Add candidate'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Application
// ---------------------------------------------------------------------------

/**
 * Putting a candidate forward for a role.
 *
 * Only published roles are offered, because the API accepts applications only against
 * one: a draft is not yet a vacancy and a closed one is history, and in both cases the
 * record would say somebody applied for something that was not open.
 */
export function CreateApplicationForm({
  jobs,
  candidates,
  fixedJobId,
  fixedCandidateId,
}: {
  jobs: JobRequisitionSummary[];
  candidates: CandidateSummary[];
  /** Pre-selected when started from a job page. */
  fixedJobId?: string;
  /** Pre-selected when started from a candidate page. */
  fixedCandidateId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openJobs = jobs.filter((job) => job.status === 'PUBLISHED');

  function submit(formData: FormData): void {
    setMessage(null);

    const jobRequisitionId = fixedJobId ?? String(formData.get('jobRequisitionId') ?? '');
    const candidateId = fixedCandidateId ?? String(formData.get('candidateId') ?? '');

    if (!jobRequisitionId || !candidateId) {
      setMessage('Choose both a role and a candidate.');
      return;
    }

    startTransition(async () => {
      const result = await createApplicationAction({
        jobRequisitionId,
        candidateId,
        source: String(formData.get('source') ?? '') || undefined,
        notes: String(formData.get('notes') ?? '').trim() || undefined,
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }

      setOpen(false);
      router.push(`/hr/recruitment/applications/${result.data.application.id}`);
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} disabled={openJobs.length === 0}>
        {openJobs.length === 0 ? 'No open roles' : 'Add application'}
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Add an application
      </h3>

      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {!fixedJobId && (
            <SelectField
              name="jobRequisitionId"
              label="Role"
              required
              options={openJobs.map((job) => ({
                value: job.id,
                label: `${job.title} (${job.code})`,
              }))}
            />
          )}
          {!fixedCandidateId && (
            <SelectField
              name="candidateId"
              label="Candidate"
              required
              options={candidates.map((c) => ({
                value: c.id,
                label: `${c.displayName} — ${c.email}`,
              }))}
            />
          )}
          <SelectField
            name="source"
            label="How this application arrived"
            options={CANDIDATE_SOURCES.map((s) => ({
              value: s,
              label: CANDIDATE_SOURCE_LABELS[s],
            }))}
            placeholder="Direct"
          />
        </div>

        <AreaField name="notes" label="Notes" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Add application'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Interview
// ---------------------------------------------------------------------------

/**
 * Booking an interview.
 *
 * The time is entered as company-time wall clock and sent with an explicit +05:30
 * offset, so what the person typed is what the server stores. Sending a bare local time
 * would be interpreted in the browser's zone and a colleague abroad would book the wrong
 * hour — the same reasoning the attendance correction form applies.
 *
 * This is also the one place in HR where a client-supplied time is legitimate: it is a
 * future appointment somebody is choosing, not a record of something that happened.
 */
export function ScheduleInterviewForm({
  applicationId,
  employees,
}: {
  applicationId: string;
  employees: { id: string; displayName: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [participantIds, setParticipantIds] = useState<string[]>([]);

  function submit(formData: FormData): void {
    setMessage(null);

    const interviewType = String(formData.get('interviewType') ?? '');
    const date = String(formData.get('date') ?? '');
    const time = String(formData.get('time') ?? '');

    if (!interviewType) {
      setMessage('Choose the kind of interview.');
      return;
    }
    if (!date || !time) {
      setMessage('Choose a date and a time.');
      return;
    }

    const duration = String(formData.get('durationMinutes') ?? '');
    const round = String(formData.get('round') ?? '');
    const interviewerId = String(formData.get('interviewerId') ?? '');

    startTransition(async () => {
      const result = await scheduleInterviewAction({
        applicationId,
        interviewType,
        round: round ? Number(round) : undefined,
        scheduledAt: `${date}T${time}:00.000+05:30`,
        durationMinutes: duration ? Number(duration) : undefined,
        location: String(formData.get('location') ?? '').trim() || undefined,
        meetingUrl: String(formData.get('meetingUrl') ?? '').trim() || undefined,
        interviewerId: interviewerId || undefined,
        participantIds: participantIds.length > 0 ? participantIds : undefined,
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }

      setOpen(false);
      setParticipantIds([]);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Schedule interview
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Schedule an interview
      </h3>

      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            name="interviewType"
            label="Kind"
            required
            options={INTERVIEW_TYPES.map((t) => ({ value: t, label: INTERVIEW_TYPE_LABELS[t] }))}
          />
          <TextField name="round" label="Round" type="number" placeholder="1" />
          <TextField name="date" label="Date" type="date" required />
          <TextField name="time" label="Time (IST)" type="time" required />
          <TextField name="durationMinutes" label="Minutes" type="number" placeholder="60" />
          <SelectField
            name="interviewerId"
            label="Lead interviewer"
            options={employees.map((e) => ({ value: e.id, label: e.displayName }))}
          />
          <TextField name="location" label="Where" />
          <TextField name="meetingUrl" label="Meeting link" />
        </div>

        {/*
          The panel. Each becomes a participant row so they can be notified and so their
          feedback is attributable — which is also what lets the backend decide whose
          feedback they may read.
        */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Others on the panel
          </legend>
          <div className="flex flex-wrap gap-2">
            {employees.map((employee) => {
              const selected = participantIds.includes(employee.id);
              return (
                <label
                  key={employee.id}
                  className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink-2"
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) =>
                      setParticipantIds((current) =>
                        event.target.checked
                          ? [...current, employee.id]
                          : current.filter((id) => id !== employee.id),
                      )
                    }
                  />
                  {employee.displayName}
                </label>
              );
            })}
          </div>
        </fieldset>

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Booking…' : 'Schedule'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Offer
// ---------------------------------------------------------------------------

/**
 * Drafting an offer.
 *
 * Needs APPROVE and a selected candidate, both checked by the API. The offer is born
 * DRAFT; sending it is a separate act so there is always a record of when it went.
 *
 * No bank detail, no tax identifier, no deduction. `annualPackage` is informational —
 * what was communicated — so a later Payroll phase has a documented starting point.
 */
export function CreateOfferForm({
  applicationId,
  defaultPosition,
  departments,
  designations,
}: {
  applicationId: string;
  defaultPosition: string;
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const position = text('position');
    const proposedJoiningDate = text('proposedJoiningDate');
    const expiresOn = text('expiresOn');

    if (!position) {
      setFieldErrors({ position: 'Name the position' });
      return;
    }
    if (!proposedJoiningDate) {
      setFieldErrors({ proposedJoiningDate: 'Choose a proposed joining date' });
      return;
    }
    // An expiry after the start date would mean the offer lapsed after the day it was
    // meant to begin. Enforced by Zod and a CHECK too.
    if (expiresOn && expiresOn > proposedJoiningDate) {
      setFieldErrors({ expiresOn: 'An offer cannot expire after the day it starts' });
      return;
    }

    const annualPackage = text('annualPackage');

    startTransition(async () => {
      const result = await createOfferAction({
        applicationId,
        position,
        departmentId: text('departmentId'),
        designationId: text('designationId'),
        employmentType: text('employmentType'),
        workMode: text('workMode'),
        location: text('location'),
        proposedJoiningDate: `${proposedJoiningDate}T00:00:00.000Z`,
        annualPackage: annualPackage ? Number(annualPackage) : undefined,
        benefitsSummary: text('benefitsSummary'),
        ...(expiresOn ? { expiresOn: `${expiresOn}T00:00:00.000Z` } : {}),
      });

      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Draft offer
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Draft an offer
      </h3>

      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="position"
            label="Position"
            required
            defaultValue={defaultPosition}
            error={fieldErrors.position}
          />
          <TextField
            name="proposedJoiningDate"
            label="Proposed joining date"
            type="date"
            required
            error={fieldErrors.proposedJoiningDate}
          />
          <TextField
            name="expiresOn"
            label="Offer expires"
            type="date"
            error={fieldErrors.expiresOn}
          />
          <SelectField
            name="departmentId"
            label="Department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="designationId"
            label="Designation"
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="employmentType"
            label="Employment type"
            options={EMPLOYMENT_TYPES.map((t) => ({
              value: t,
              label: EMPLOYMENT_TYPE_LABELS[t],
            }))}
            placeholder="Full time"
          />
          <SelectField
            name="workMode"
            label="Work mode"
            options={WORK_MODES.map((m) => ({ value: m, label: WORK_MODE_LABELS[m] }))}
            placeholder="On site"
          />
          <TextField name="location" label="Location" />
          <TextField name="annualPackage" label="Annual package" type="number" />
        </div>

        <AreaField name="benefitsSummary" label="Benefits summary" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Draft offer'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

/**
 * Requesting a check.
 *
 * One of each type per application: re-requesting the same type resets that check rather
 * than accumulating rows nobody can order. The result is recorded separately and needs
 * APPROVE, because an adverse verification can end somebody's prospects.
 */
export function RequestBackgroundCheckForm({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);

    const checkType = String(formData.get('checkType') ?? '');
    if (!checkType) {
      setMessage('Choose the kind of check.');
      return;
    }

    startTransition(async () => {
      const result = await requestBackgroundCheckAction({
        applicationId,
        checkType,
        verifierName: String(formData.get('verifierName') ?? '').trim() || undefined,
        notes: String(formData.get('notes') ?? '').trim() || undefined,
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }

      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Request a check
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Request a background check
      </h3>

      <form action={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            name="checkType"
            label="Kind"
            required
            options={BACKGROUND_CHECK_TYPES.map((t) => ({
              value: t,
              label: BACKGROUND_CHECK_TYPE_LABELS[t],
            }))}
          />
          <TextField name="verifierName" label="Who is running it" />
        </div>

        <AreaField name="notes" label="Notes" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Request'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

/**
 * Starting an onboarding from an accepted offer.
 *
 * Takes the agreed start date and the placement. Everything else is already on the
 * accepted offer, and the service reads it from there — so the onboarding cannot
 * disagree with what the candidate accepted.
 */
export function StartOnboardingForm({
  applicationId,
  departments,
  designations,
  employees,
  defaultJoiningDate,
}: {
  applicationId: string;
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
  employees: { id: string; displayName: string }[];
  defaultJoiningDate: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);

    const joiningDate = String(formData.get('joiningDate') ?? '');
    if (!joiningDate) {
      setMessage('Choose the agreed joining date.');
      return;
    }

    const text = (key: string): string | undefined => {
      const value = String(formData.get(key) ?? '').trim();
      return value === '' ? undefined : value;
    };

    startTransition(async () => {
      const result = await createOnboardingAction({
        applicationId,
        joiningDate: `${joiningDate}T00:00:00.000Z`,
        departmentId: text('departmentId'),
        designationId: text('designationId'),
        managerId: text('managerId'),
        notes: text('notes'),
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }

      setOpen(false);
      router.push(`/hr/onboarding/${result.data.onboarding.id}`);
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Start onboarding
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Start onboarding
      </h3>

      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="joiningDate"
            label="Agreed joining date"
            type="date"
            required
            defaultValue={defaultJoiningDate?.slice(0, 10) ?? ''}
          />
          <SelectField
            name="departmentId"
            label="Department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="designationId"
            label="Designation"
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            name="managerId"
            label="Reporting manager"
            options={employees.map((e) => ({ value: e.id, label: e.displayName }))}
          />
        </div>

        <AreaField name="notes" label="Notes" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Start onboarding'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Shared field controls
// ---------------------------------------------------------------------------

function TextField({
  name,
  label,
  type = 'text',
  required = false,
  error,
  placeholder,
  defaultValue,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  error?: string;
  placeholder?: string;
  defaultValue?: string;
  step?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <Input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        step={step}
        aria-invalid={Boolean(error)}
      />
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}

function AreaField({ name, label }: { name: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>{label}</Label>
      <Textarea id={name} name={name} rows={3} />
    </div>
  );
}

/**
 * A plain native select.
 *
 * The shadcn `Select` is a popover needing its own open state and does not submit with a
 * form. For form fields read straight out of FormData, a native element is fewer moving
 * parts and keyboard-accessible for nothing — the same choice the employee form and the
 * attendance filters make.
 */
function SelectField({
  name,
  label,
  options,
  required = false,
  placeholder,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <select
        id={name}
        name={name}
        defaultValue=""
        className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        <option value="">{placeholder ?? 'Not set'}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
