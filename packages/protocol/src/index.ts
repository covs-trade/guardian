export type {
  ProtocolOperation,
  OperationStatus,
  ProtocolTxStatus,
  ProtocolToken,
  ProtocolEventType,
  ProtocolEvent,
  ProtocolTransactionStatus,
  OutputKind,
  TransactionOutput,
  TransactionInput,
  TransactionSummary,
  UnsignedProtocolTransaction,
  ValidationResult,
  BuildDeployInput,
  BuildMintInput,
  BuildSellInput,
  BuildBuyInput,
  BuildCancelInput,
  DecodedProtocolTransaction,
  VerificationStatus,
  FeeBreakdown,
  ProtocolListing,
  DecodedSignedTransaction,
} from "./types.js";
export type { CRCProtocolAdapter } from "./adapter.js";
export {
  ProtocolError,
  isProtocolError,
  type ProtocolErrorCode,
} from "./errors.js";
export {
  VERIFIED,
  UNVERIFIED,
  PRECOP_MAINNET_VERIFICATION,
  MOCK_VERIFICATION,
} from "./verification.js";
export {
  MockCRCAdapter,
  toProtocolToken,
  toProtocolEvent,
} from "./mock/adapter.js";
export { MockChainNode, type MockHealth } from "./mock/node.js";
export {
  MemoryStorage,
  RedisMockStorage,
  type MockStorage,
  type RedisLike,
} from "./mock/store.js";
export {
  createInitialState,
  mineBlock,
  reorg,
  rebuildDerivedState,
  getStateHash,
  ensureWallet,
  getConfirmedEvents,
  assertProtocolInvariants,
  MOCK_FAUCET_SATS,
} from "./mock/chain.js";
export {
  DEFAULT_MOCK_PROTOCOL_CONFIG,
  MOCK_TREASURY_ADDRESS,
  MOCK_RESERVE_ADDRESS,
  MOCK_PROTOCOL_FEE_ADDRESS,
  CRC_LAUNCH_V1_PROFILE,
  type ProtocolConfig,
} from "./validation/config.js";
export {
  outputsToAddress,
  sumOutputsByKind,
  findOutputByKind,
  countOutputsByKind,
  countOutputsToAddress,
  type OpValidationResult,
} from "./validation/common.js";
export type {
  MockChainState,
  MockToken,
  MockListing,
  MockEvent,
  MockTx,
  MockTxEnvelope,
  MockBlock,
  MockTxStatus,
  WalletBalance,
} from "./mock/types.js";
export {
  buildEnvelope,
  envelopeToPsbt,
  envelopeFromPsbt,
  parseSignedMockPsbt,
  isMockSignedPsbt,
  newMockTxid,
} from "./mock/envelope.js";
export { seedMockChain } from "./mock/seed.js";
export { PrecopCRCAdapter } from "./precop.js";
export {
  decodeCrc20Json,
  decodeCrc20OpReturn,
  OBSERVED_LEAF_TRANSFER,
  type Crc20Payload,
} from "./crc20.js";
export type {
  CanonicalCRCProvider,
  CRCCapabilities,
  TickerValidation,
  DeploymentAuthorizationRequest,
  DeploymentAuthorization,
  DeploymentRules,
  MintRules,
  MintAuthorizationRequest,
  MintAuthorization,
  SignedCRCOperation,
  CRCSubmissionResult,
  CRCOperationStatus,
  CanonicalTokenState,
  CanonicalActivityItem,
  CanonicalActivityPage,
  CanonicalOperationKind,
} from "./canonical.js";
export {
  MockCanonicalCRCProvider,
  UnavailableCanonicalCRCProvider,
  crcLaunchV1DeploymentRules,
} from "./canonical-mock.js";
export {
  COVE_MAGIC,
  COVE_VERSION,
  OP_DEPLOY,
  OP_MINT,
  OP_TRANSFER,
  COVE_DEPLOY_LEN,
  COVE_MINT_LEN,
  COVE_TRANSFER_LEN,
  encodeCoveDeploy,
  encodeCoveMint,
  encodeCoveTransfer,
  decodeCoveEnvelope,
  isCoveMagic,
  type CoveEnvelope,
  type CoveOp,
  type CoveDeploy,
  type CoveMint,
  type CoveTransfer,
  type CoveDecodeResult,
} from "./cove/envelope.js";
export {
  COVE_V1_SIGNET_GENESIS_HEIGHT,
  COVE_V1_MAINNET_GENESIS_HEIGHT,
  COVE_V1_MAINNET_SETTLEMENT_SCRIPT,
  COVE_V1_MAINNET_TREASURY_SCRIPT,
  COVE_V1_SIGNET_CONFIG,
  COVE_MUTINYNET_GENESIS_HEIGHT,
  COVE_MUTINYNET_CONFIG,
  COVE_V1_REGTEST_CONFIG,
  COVE_V1_MAINNET_CONFIG,
  isCoveMainnetActivated,
  configDomain,
  type CoveConfig,
} from "./cove/config.js";
export {
  createCoveState,
  type CoveState,
  type CoveToken,
  type CoveBalance,
  type CoveTransaction,
  type CoveOperationKind,
  type ProtocolOwnerId,
  type CoveProtocolOutput,
  type CoveValidationResult,
} from "./cove/types.js";
export {
  validateCoveOperation,
  applyCoveOperation,
  isSupportedScript,
} from "./cove/validator.js";
export { toCoveTransaction, type CoveMapResult } from "./cove/mapper.js";
export { computeStateRoot } from "./cove/state-root.js";
export { referenceComputeStateRoot } from "./cove/state-root-reference.js";
export { assertCoveInvariants } from "./cove/invariants.js";
export {
  buildCoveDeployPsbt,
  buildCoveMintPsbt,
  buildCoveTransferPsbt,
  anchorAmount,
  type BuildDeployParams,
  type BuildMintParams,
  type BuildTransferParams,
} from "./cove/build.js";
