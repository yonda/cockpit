export type StatusCheckState =
  | "SUCCESS"
  | "PENDING"
  | "FAILURE"
  | "ERROR"
  | null;

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type ReviewerState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export type Reviewer = {
  key: string;
  displayName: string;
  avatarUrl: string;
  isTeam: boolean;
  state: ReviewerState;
};

export type PullRequestCard = {
  id: string;
  number: number;
  title: string;
  url: string;
  repositoryNameWithOwner: string;
  authorLogin: string;
  authorAvatarUrl: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: ReviewDecision;
  mergeable: Mergeable;
  statusCheckRollup: StatusCheckState;
  commentCount: number;
  reviewThreadCount: number;
  viewerHasReviewed: boolean;
  viewerLatestReviewState:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING"
    | null;
  reviewers: Reviewer[];
};

export type Tier = "now" | "soon" | "waiting";

export type CardOrigin = "mine" | "review";


