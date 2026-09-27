import type { Sats, Atoms } from "@crclaunch/curve";
export interface CRCCapabilities {
  arbitraryDeploy: boolean;
  progressiveMint: boolean;
  customSupply: boolean;
  oracleAuthorization: boolean;
  canonicalBalanceQuery: boolean;
  transfer: boolean;
  marketplace: boolean;
  graduation: boolean;
  vault: boolean;
}
export interface TickerValidation {
  ticker: string;
  valid: boolean;
  reason?: string;
}
export interface DeploymentAuthorizationRequest {
  ticker: string;
  name: string;
  profile?: string;
  creatorAddress: string;
}
export interface DeploymentAuthorization {
  authorized: boolean;
  deploymentId?: string;
  expiresAt?: string;
  reason?: string;
}
export interface DeploymentRules {
  profile: string;
  maxSupplyAtoms: Atoms;
  decimals: number;
  publicBps: number;
  reserveBps: number;
  stageCount: number;
  priceTableSatsPerMillion: readonly Sats[];
  creatorPremineAtoms: Atoms;
}
export interface MintRules {
  deploymentId: string;
  profile: string;
  stageCount: number;
  priceTableSatsPerMillion: readonly Sats[];
  remainingPublicSupplyAtoms: Atoms;
  minimumContributionSats: Sats;
}
export interface MintAuthorizationRequest {
  deploymentId: string;
  walletAddress: string;
  requestedAmountAtoms: Atoms;
}
export interface MintAuthorization {
  authorized: boolean;
  requiredPaymentSats: Sats;
  tokenAmountAtoms: Atoms;
  startingStage: number;
  endingStage: number;
  supplyBeforeAtoms: Atoms;
  supplyAfterAtoms: Atoms;
  authorizationId?: string;
  expiresAt?: string;
  reason?: string;
}
export type CanonicalOperationKind =
  "deploy" | "mint" | "transfer" | "list" | "buy" | "cancel";
export interface SignedCRCOperation {
  operation: CanonicalOperationKind;
  walletAddress: string;
  signedTransactionHex: string;
  deploymentId?: string;
  ticker?: string;
  authorizationId?: string;
}
export interface CRCSubmissionResult {
  operationId: string;
  status: "submitted" | "accepted" | "rejected";
  reason?: string;
}
export interface CRCOperationStatus {
  operationId: string;
  status: "pending" | "accepted" | "rejected" | "finalized";
  txid?: string;
  blockHeight?: bigint;
  reason?: string;
}
export interface CanonicalTokenState {
  deploymentId: string;
  ticker: string;
  status: string;
  totalSupplyAtoms: Atoms;
  confirmedMintedAtoms: Atoms;
  remainingPublicSupplyAtoms: Atoms;
  currentStage: number;
  reserveSats: Sats;
  stateHash: string;
}
export interface CanonicalActivityItem {
  txid: string;
  blockHeight: bigint;
  type: string;
  ticker?: string;
  amountAtoms?: Atoms;
  btcSats?: Sats;
  timestamp: string;
}
export interface CanonicalActivityPage {
  items: CanonicalActivityItem[];
  nextCursor: string | null;
}
export interface CanonicalCRCProvider {
  getCapabilities(): Promise<CRCCapabilities>;
  validateTicker(ticker: string): Promise<TickerValidation>;
  requestDeploymentAuthorization(
    params: DeploymentAuthorizationRequest,
  ): Promise<DeploymentAuthorization>;
  getDeploymentRules(): Promise<DeploymentRules>;
  getMintRules(deploymentId: string): Promise<MintRules>;
  requestMintAuthorization(
    request: MintAuthorizationRequest,
  ): Promise<MintAuthorization>;
  submitSignedOperation(
    operation: SignedCRCOperation,
  ): Promise<CRCSubmissionResult>;
  getOperationStatus(operationId: string): Promise<CRCOperationStatus>;
  getCanonicalState(deploymentId: string): Promise<CanonicalTokenState>;
  getCanonicalActivity(cursor?: string): Promise<CanonicalActivityPage>;
}
