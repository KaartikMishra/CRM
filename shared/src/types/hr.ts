import type {
  DocumentVerificationStatus,
  EmployeeDocumentType,
  EmployeeEventType,
  EmployeeStatus,
  EmploymentType,
  OrgUnitStatus,
  WorkMode,
} from '../enums.js';

/**
 * The HR view contracts — what the API returns, shared by both tiers.
 *
 * Every shape here is what the browser receives, so a field absent from these
 * types is a field the frontend cannot render even by accident. That is the
 * principal reason they are written out rather than inferred from Prisma: the
 * database row and the API response are deliberately not the same thing.
 *
 * Dates cross the wire as ISO strings. Prisma hands back `Date`, the service
 * serialises, and typing them as `string` here is what stops a component calling
 * `.getTime()` on something that is no longer a Date.
 */

/** A person named in passing — a manager, a head, whoever acted. */
export type EmployeeRef = {
  id: string;
  employeeId: string;
  displayName: string;
};

/** An organizational unit named in passing. */
export type OrgUnitRef = {
  id: string;
  name: string;
  code: string;
};

export type DepartmentView = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: OrgUnitStatus;
  parent: OrgUnitRef | null;
  head: EmployeeRef | null;
  /**
   * Derived, never stored: counting rows is the database's job and a stored tally
   * would be a second answer free to drift from the employees themselves.
   */
  employeeCount: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DesignationView = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: OrgUnitStatus;
  department: OrgUnitRef | null;
  level: number;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * One row of the employee directory.
 *
 * Deliberately not the full profile. A directory listing 500 people should not
 * carry 500 phone numbers and 500 history timelines, and a list row is seen by
 * everybody who may read the module — so it holds what a colleague legitimately
 * needs to find somebody and nothing more.
 */
export type EmployeeRow = {
  id: string;
  employeeId: string;
  displayName: string;
  workEmail: string;
  department: OrgUnitRef | null;
  designation: OrgUnitRef | null;
  manager: EmployeeRef | null;
  status: EmployeeStatus;
  employmentType: EmploymentType;
  workMode: WorkMode;
  joiningDate: string;
  /** Whether this person holds a CRM login. The account itself is not exposed. */
  hasAccount: boolean;
};

export type EmployeePage = {
  employees: EmployeeRow[];
  nextCursor: string | null;
};

/** The account tied to an employee. Identity only — never a credential. */
export type EmployeeAccountRef = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: 'ADMIN' | 'USER';
  isActive: boolean;
};

export type EmployeeHistoryEntry = {
  id: string;
  eventType: EmployeeEventType;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  performedBy: { id: string; name: string } | null;
  effectiveAt: string;
};

/**
 * One employee document's metadata.
 *
 * Note what is absent: any URL. The file is reached through its own endpoint,
 * which resolves permission and then mints a short-lived signed link. A URL on
 * this type would be handed out with every list response and would outlive every
 * access check — which is exactly why SecureDocument stores none.
 */
export type EmployeeDocumentView = {
  id: string;
  documentType: EmployeeDocumentType;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  bytes: number | null;
  issuedOn: string | null;
  expiresOn: string | null;
  /** Derived from `expiresOn` against the clock, so it cannot go stale. */
  isExpired: boolean;
  verificationStatus: DocumentVerificationStatus;
  verifiedBy: { id: string; name: string } | null;
  verifiedAt: string | null;
  uploadedBy: { id: string; name: string } | null;
  createdAt: string;
};

/** A freshly minted, short-lived link to one stored document. */
export type EmployeeDocumentLink = {
  url: string;
  expiresAt: string;
};

/** The full profile — one query, assembled by the service. */
export type EmployeeDetail = EmployeeRow & {
  firstName: string;
  middleName: string | null;
  lastName: string;
  phone: string | null;
  location: string | null;
  exitDate: string | null;
  account: EmployeeAccountRef | null;
  /** Direct reports only. The whole subtree is not a Phase 1 concern. */
  reports: EmployeeRef[];
  history: EmployeeHistoryEntry[];
  documents: EmployeeDocumentView[];
  createdAt: string;
  updatedAt: string;
};

export type DepartmentPage = {
  departments: DepartmentView[];
  nextCursor: string | null;
};

export type DesignationPage = {
  designations: DesignationView[];
  nextCursor: string | null;
};

/**
 * The HR landing figures.
 *
 * Four counts, every one answerable from the tables Phase 1 ships. There is
 * deliberately no attrition rate, headcount trend, average tenure or diversity
 * breakdown: Phase 1 holds no time series to compute them from, and a tile reading
 * 0% would be a confident lie rather than an honest absence.
 */
export type HrOverview = {
  totalEmployees: number;
  /** PROBATION, ACTIVE or ON_NOTICE — see EMPLOYED_STATUSES. */
  employedCount: number;
  activeDepartments: number;
  activeDesignations: number;
};
