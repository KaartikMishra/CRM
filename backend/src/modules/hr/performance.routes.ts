/**
 * The performance route table — who may reach what, and nothing else.
 *
 * Every route carries a `requirePermission` or `requireAnyPermission`. `requireAuth`
 * is applied once on the parent `hrRoutes` router, so it is not repeated here.
 *
 * ### The route table cannot answer the questions that matter most
 *
 * It knows grants. It does not know whether this actor is the subject of this
 * review, whether they are the employee's manager, or whether the review is already
 * finalised — those are facts about rows. So the table admits anybody holding the
 * grant and `performance-access.ts` plus the services decide.
 *
 * That split is why **`EMPLOYEE_FLOOR` looks permissive and is not**. An employee
 * writing their own self-assessment holds no performance grant at all — everybody is
 * appraised, so requiring one would mean granting the module to the whole company
 * and the grant would stop meaning anything. The floor lets them reach the route;
 * the service then refuses anybody who is not the subject, including an
 * administrator holding every grant.
 *
 * ### Literal paths before parameterised ones
 *
 * `/performance/cycles/mine` would be parsed as `/performance/cycles/:id` if it came
 * second. Every literal segment below is declared before the `:id` route that could
 * swallow it, which is the convention the whole codebase follows.
 */

import { Router } from 'express';
import {
  cancelReviewSchema,
  closeDevelopmentPlanSchema,
  closeGoalSchema,
  closeReviewCycleSchema,
  competencyParamSchema,
  completeDevelopmentActionSchema,
  createCompetencySchema,
  createDevelopmentActionSchema,
  createDevelopmentPlanSchema,
  createGoalSchema,
  createKpiSchema,
  createReviewCycleSchema,
  developmentActionParamSchema,
  developmentPlanListQuerySchema,
  developmentPlanParamSchema,
  finalizeReviewSchema,
  generateReviewsSchema,
  goalKpiParamSchema,
  goalListQuerySchema,
  goalParamSchema,
  performanceEmployeeParamSchema,
  performanceHistoryQuerySchema,
  performanceReviewListQuerySchema,
  performanceReviewParamSchema,
  rateCompetencySchema,
  recordKpiProgressSchema,
  reviewCycleListQuerySchema,
  reviewCycleParamSchema,
  saveManagerAssessmentSchema,
  saveSelfAssessmentSchema,
  submitReviewSchema,
  updateCompetencySchema,
  updateDevelopmentPlanSchema,
  updateGoalSchema,
  updateKpiSchema,
  updateReviewCycleSchema,
} from '@rs/shared';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './performance.controller.js';

export const performanceRoutes = Router();

/**
 * The floor for somebody acting on their own records.
 *
 * `HR_EMPLOYEE:VIEW` is what every employee who can see the directory holds. The
 * service then refuses anybody but the subject — see the file note. The same
 * pattern Phase 4's `LEARNER_FLOOR` established, for the same reason: the
 * population this serves is everybody.
 */
const EMPLOYEE_FLOOR = [
  ['HR_PERFORMANCE', 'VIEW'],
  ['HR_EMPLOYEE', 'VIEW'],
] as const;

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

/**
 * The landing figures.
 *
 * Open to the employee floor, because the dashboard includes "what you owe" — and
 * an employee who could not see their own outstanding self-assessment would have no
 * way to find it. Every count is scoped server-side.
 */
performanceRoutes.get(
  '/performance/overview',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  controller.getOverview,
);

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

performanceRoutes.post(
  '/performance/cycles',
  requirePermission('HR_PERFORMANCE', 'CREATE'),
  validate({ body: createReviewCycleSchema }),
  controller.createCycle,
);

performanceRoutes.get(
  '/performance/cycles',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ query: reviewCycleListQuerySchema }),
  controller.listCycles,
);

/*
  Readable by the employee floor: a cycle is the terms somebody is being judged
  against, and withholding them would be withholding the rules of their own
  appraisal. Nothing on a cycle is personal to anybody.
*/
performanceRoutes.get(
  '/performance/cycles/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: reviewCycleParamSchema }),
  controller.getCycle,
);

performanceRoutes.patch(
  '/performance/cycles/:id',
  requirePermission('HR_PERFORMANCE', 'CREATE'),
  validate({ params: reviewCycleParamSchema, body: updateReviewCycleSchema }),
  controller.updateCycle,
);

/*
  Opening, closing and archiving need APPROVE rather than CREATE. Each commits the
  organisation — opening makes every employee in scope owe a self-assessment with a
  deadline — which is the line APPROVE marks everywhere else in HR.
*/
performanceRoutes.post(
  '/performance/cycles/:id/activate',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: reviewCycleParamSchema }),
  controller.activateCycle,
);

performanceRoutes.post(
  '/performance/cycles/:id/close',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: reviewCycleParamSchema, body: closeReviewCycleSchema }),
  controller.closeCycle,
);

performanceRoutes.post(
  '/performance/cycles/:id/archive',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: reviewCycleParamSchema }),
  controller.archiveCycle,
);

/** Generating a cycle's reviews. APPROVE, for the same reason as opening it. */
performanceRoutes.post(
  '/performance/cycles/:id/reviews',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: reviewCycleParamSchema, body: generateReviewsSchema }),
  controller.generateReviews,
);

/**
 * A cycle's report.
 *
 * VIEW only, not the employee floor. A report is company-wide aggregate data —
 * distributions and departmental averages — which an individual employee has no
 * entitlement to, even about a cycle they are in.
 */
performanceRoutes.get(
  '/performance/cycles/:id/report',
  requirePermission('HR_PERFORMANCE', 'VIEW'),
  validate({ params: reviewCycleParamSchema }),
  controller.getCycleReport,
);

/** The competency sheet. CREATE, because it defines what everybody is judged on. */
performanceRoutes.post(
  '/performance/cycles/:id/competencies',
  requirePermission('HR_PERFORMANCE', 'CREATE'),
  validate({ params: reviewCycleParamSchema, body: createCompetencySchema }),
  controller.addCompetency,
);

performanceRoutes.patch(
  '/performance/competencies/:id',
  requirePermission('HR_PERFORMANCE', 'CREATE'),
  validate({ params: competencyParamSchema, body: updateCompetencySchema }),
  controller.updateCompetency,
);

performanceRoutes.delete(
  '/performance/competencies/:id',
  requirePermission('HR_PERFORMANCE', 'CREATE'),
  validate({ params: competencyParamSchema }),
  controller.removeCompetency,
);

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

/**
 * Setting a goal. ASSIGN, because it places an obligation with a deadline on
 * somebody — the same grant Phase 4 uses for putting a colleague into a course.
 */
performanceRoutes.post(
  '/performance/goals',
  requirePermission('HR_PERFORMANCE', 'ASSIGN'),
  validate({ body: createGoalSchema }),
  controller.createGoal,
);

/*
  Listing is on the employee floor and scoped server-side: an employee sees their own
  goals and their department's, a manager sees their reports' too. A department goal
  is deliberately visible to everybody in the unit — somebody who could not see what
  their team is working towards could not align their own goals to it.
*/
performanceRoutes.get(
  '/performance/goals',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ query: goalListQuerySchema }),
  controller.listGoals,
);

performanceRoutes.get(
  '/performance/goals/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalParamSchema }),
  controller.getGoal,
);

/*
  Editing is on the floor too, and the service decides. The owner's manager holds no
  performance grant in the ordinary case — being somebody's manager is a fact about
  rows — so gating this on ASSIGN would stop the very people who set goals from
  amending them. The service refuses the owner editing their own target.
*/
performanceRoutes.patch(
  '/performance/goals/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalParamSchema, body: updateGoalSchema }),
  controller.updateGoal,
);

performanceRoutes.post(
  '/performance/goals/:id/activate',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalParamSchema }),
  controller.activateGoal,
);

performanceRoutes.post(
  '/performance/goals/:id/close',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalParamSchema, body: closeGoalSchema }),
  controller.closeGoal,
);

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

performanceRoutes.post(
  '/performance/goals/:id/kpis',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalParamSchema, body: createKpiSchema }),
  controller.addKpi,
);

performanceRoutes.patch(
  '/performance/goals/:id/kpis/:kpiId',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalKpiParamSchema, body: updateKpiSchema }),
  controller.updateKpi,
);

performanceRoutes.delete(
  '/performance/goals/:id/kpis/:kpiId',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalKpiParamSchema }),
  controller.removeKpi,
);

/*
  Recording progress is on the floor deliberately. The goal's owner records their own
  figures — they are the one who knows the number, and making them ask their manager
  to type it would mean the figures are always stale. They cannot change the target,
  which is the part that matters.

  The body carries a measurement and nothing else: `recordKpiProgressSchema` has no
  attainment field, so a client-supplied performance result is impossible to express.
*/
performanceRoutes.post(
  '/performance/goals/:id/kpis/:kpiId/progress',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalKpiParamSchema, body: recordKpiProgressSchema }),
  controller.recordProgress,
);

performanceRoutes.get(
  '/performance/goals/:id/kpis/:kpiId/progress',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: goalKpiParamSchema }),
  controller.listProgress,
);

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

performanceRoutes.get(
  '/performance/reviews',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ query: performanceReviewListQuerySchema }),
  controller.listReviews,
);

performanceRoutes.get(
  '/performance/reviews/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceReviewParamSchema }),
  controller.getReview,
);

/*
  The self-assessment. On the floor, and the service refuses everybody but the
  subject — including an administrator holding every grant. There is no business
  case for a self-assessment written by somebody else.
*/
performanceRoutes.patch(
  '/performance/reviews/:id/self-assessment',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceReviewParamSchema, body: saveSelfAssessmentSchema }),
  controller.saveSelfAssessment,
);

performanceRoutes.post(
  '/performance/reviews/:id/self-assessment/submit',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceReviewParamSchema, body: submitReviewSchema }),
  controller.submitSelfAssessment,
);

/*
  The manager assessment. Also on the floor, because a reviewer is usually an
  ordinary colleague holding no performance grant. The service refuses **the subject
  first**, before any permission check — so an HR colleague being appraised cannot
  write their own.
*/
performanceRoutes.patch(
  '/performance/reviews/:id/manager-assessment',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceReviewParamSchema, body: saveManagerAssessmentSchema }),
  controller.saveManagerAssessment,
);

performanceRoutes.post(
  '/performance/reviews/:id/manager-assessment/submit',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceReviewParamSchema, body: submitReviewSchema }),
  controller.submitManagerAssessment,
);

/**
 * Finalising a review.
 *
 * APPROVE, and the only route in this table that carries it for a per-review act.
 * This is the second pair of eyes the requirement asks for: a manager who wrote the
 * review holds EDIT at most and cannot close it.
 *
 * The service additionally refuses an approver who is the subject, which no route
 * guard could express.
 */
performanceRoutes.post(
  '/performance/reviews/:id/finalize',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: performanceReviewParamSchema, body: finalizeReviewSchema }),
  controller.finalizeReview,
);

performanceRoutes.post(
  '/performance/reviews/:id/cancel',
  requirePermission('HR_PERFORMANCE', 'APPROVE'),
  validate({ params: performanceReviewParamSchema, body: cancelReviewSchema }),
  controller.cancelReview,
);

/**
 * An HR competency rating.
 *
 * EDIT. The service refuses `source: 'SELF'` and `'MANAGER'` through this route —
 * those belong to the people whose assessments they are, and a general rating
 * endpoint accepting SELF would be the obvious way around the self-assessment rule.
 */
performanceRoutes.post(
  '/performance/reviews/:id/ratings',
  requirePermission('HR_PERFORMANCE', 'EDIT'),
  validate({ params: performanceReviewParamSchema, body: rateCompetencySchema }),
  controller.rateCompetency,
);

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

/*
  On the floor, because a manager writing a plan for their report holds no
  performance grant. The service refuses the subject authoring a plan about
  themselves — an improvement plan is a document the business is accountable for.
*/
performanceRoutes.post(
  '/performance/plans',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ body: createDevelopmentPlanSchema }),
  controller.createPlan,
);

performanceRoutes.get(
  '/performance/plans',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ query: developmentPlanListQuerySchema }),
  controller.listPlans,
);

performanceRoutes.get(
  '/performance/plans/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentPlanParamSchema }),
  controller.getPlan,
);

performanceRoutes.patch(
  '/performance/plans/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentPlanParamSchema, body: updateDevelopmentPlanSchema }),
  controller.updatePlan,
);

performanceRoutes.post(
  '/performance/plans/:id/close',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentPlanParamSchema, body: closeDevelopmentPlanSchema }),
  controller.closePlan,
);

performanceRoutes.post(
  '/performance/plans/:id/actions',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentPlanParamSchema, body: createDevelopmentActionSchema }),
  controller.addAction,
);

/*
  Ticking an action off is on the floor and the subject **is** allowed — doing the
  things a plan asks for is their work, and requiring a manager to record each one
  would make the plan a tracking burden rather than a support. They still cannot
  add, remove or reword actions.
*/
performanceRoutes.patch(
  '/performance/actions/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentActionParamSchema, body: completeDevelopmentActionSchema }),
  controller.completeAction,
);

performanceRoutes.delete(
  '/performance/actions/:id',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: developmentActionParamSchema }),
  controller.removeAction,
);

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------

/**
 * One person's appraisal history.
 *
 * On the floor and scoped in the service: an employee reads their own, a manager
 * their reports', HR everybody's. Finalized reviews only — a history including
 * drafts would make a trend line out of noise.
 */
performanceRoutes.get(
  '/performance/employees/:id/history',
  requireAnyPermission(...EMPLOYEE_FLOOR),
  validate({ params: performanceEmployeeParamSchema, query: performanceHistoryQuerySchema }),
  controller.getHistory,
);
