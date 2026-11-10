// What a maintainer attaches to post a bounty, from the contract's own configuration: the reward,
// the merge-check budget and the storage deposit (0.029 NEAR for the pilot), exactly.
export interface PostingConfig {
  budget: string;
  storage_deposit: string;
}

export function postingAttachment(config: PostingConfig, reward: bigint) {
  const budget = BigInt(config.budget);
  const storage = BigInt(config.storage_deposit);
  return { reward, budget, storage, total: reward + budget + storage };
}
