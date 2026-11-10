//! Vault lifecycle: address derivation, funding before and after initialization, what each
//! failure does with the attached NEAR, the publication cost, and why nobody can change a vault.

mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::test]
async fn vault_lifecycle_cost_and_immutability() -> anyhow::Result<()> {
    let env = setup().await?;
    let status = rpc(&env, "status", json!([])).await?;
    println!(
        "sandbox {} protocol {} chain {}",
        status["result"]["version"], status["result"]["protocol_version"], env.chain
    );
    let size = wasm(VAULT_WASM)?.len() as u128;
    println!(
        "vault code {} bytes, hash {}; publishing it as a global contract cost {} NEAR (bytes x 10^20, plus {} gas)",
        size,
        b58(&env.code_hash),
        near(env.global_cost),
        near(env.global_cost.saturating_sub(size * 10 * BYTE_COST)),
    );
    assert!(env.global_cost >= size * 10 * BYTE_COST);
    let vault = vault_of(&env, &env.contrib_key).await?;
    let entries = vault_entries(&pk33(&env.contrib_key));
    assert_ne!(
        vault,
        vault_of(&env, &env.maint_key).await?,
        "one vault per key"
    );
    assert_ne!(
        vault,
        derive([7u8; 32], &entries),
        "other code, other address"
    );

    // Funding an absent address creates it, uninitialized.
    assert!(account(&env, &vault).await?.is_none());
    let r = env
        .stranger
        .transfer_near(&vault, NearToken::from_millinear(500))
        .await?;
    trace(
        &env,
        "plain transfer of 0.5 to the absent vault",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(bal(&env, &vault).await?, 500 * MILLI);
    println!("  uninitialized: {} bytes", usage(&env, &vault).await?);

    // Initialization data for another key: the runtime refuses to create the receipt.
    let wrong = vault_entries(&pk33(&env.maint_key));
    let before = bal(&env, env.third.id()).await?;
    let r = state_init(&env, &vault, env.code_hash, &wrong, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit with another key's data",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        env.third.id().as_str(),
        "InvalidDeterministicStateInitReceiver"
    ));
    assert!(rows.iter().all(|(_, to, _, _)| to != vault.as_str()));
    assert!(
        before - bal(&env, env.third.id()).await? < MILLI,
        "only gas was spent"
    );

    // Undeployed code: refused at the vault, attached NEAR refunded.
    let target = derive([9u8; 32], &entries);
    let r = state_init(&env, &target, [9u8; 32], &entries, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit with an undeployed code hash",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        target.as_str(),
        "GlobalContractDoesNotExist"
    ));
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));

    // Too little for state above the zero-balance limit: refused and refunded; enough: kept.
    let mut big = entries.clone();
    big.push((b"pad".to_vec(), vec![0u8; 3_000]));
    let target = derive(env.code_hash, &big);
    let r = state_init(&env, &target, env.code_hash, &big, 10 * MILLI).await?;
    let rows = trace(&env, "StateInit of 3 KB with 0.01", &r, env.third.id()).await?;
    assert!(failed_with(&rows, target.as_str(), "LackBalanceForState"));
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));
    let r = state_init(&env, &target, env.code_hash, &big, 50 * MILLI).await?;
    let rows = trace(&env, "StateInit of 3 KB with 0.05", &r, env.third.id()).await?;
    assert!(rows
        .iter()
        .all(|(_, to, _, f)| to != target.as_str() || f.is_none()));
    let kept = bal(&env, &target).await?;
    assert_eq!(kept, u128::from(usage(&env, &target).await?) * BYTE_COST);
    println!("  3 KB vault kept {} NEAR, exactly its storage", near(kept));

    // Initializing the pre-funded vault with nothing attached: zero-balance, money untouched.
    let r = state_init(&env, &vault, env.code_hash, &entries, 0).await?;
    let rows = trace(
        &env,
        "StateInit of the pre-funded vault, 0 attached",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, _, _, f)| f.is_none()));
    println!("  initialized: {} bytes", usage(&env, &vault).await?);
    assert_eq!(bal(&env, &vault).await?, 500 * MILLI);
    let i = info(&env, &vault).await?;
    assert_eq!((i.next, i.fund, i.available), (0, 0, 500 * MILLI));

    // Funding an active vault; StateInit on an active vault does nothing and refunds.
    env.stranger
        .transfer_near(&vault, NearToken::from_millinear(100))
        .await?
        .into_result()?;
    let r = state_init(&env, &vault, env.code_hash, &entries, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit of an active vault with 0.01",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));
    assert_eq!(bal(&env, &vault).await?, 600 * MILLI);

    // Nobody can add a key, replace the code, delete it or switch its global code.
    let keys = rpc(
        &env,
        "query",
        json!({"request_type": "view_access_key_list", "finality": "final", "account_id": vault}),
    )
    .await?;
    assert_eq!(keys["result"]["keys"], json!([]));
    let code_before = account(&env, &vault).await?.unwrap()["global_contract_hash"].clone();
    for op in ["add_key", "deploy", "delete", "use_global"] {
        let r = env
            .third
            .call("poke")
            .args_json(json!({"target": vault, "op": op, "key": public(&env.maint_key)}))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        let rows = trace(
            &env,
            &format!("{op} on the vault from another account"),
            &r,
            env.third.id(),
        )
        .await?;
        assert!(
            failed_with(&rows, vault.as_str(), "ActorNoPermission"),
            "{op}"
        );
    }
    assert_eq!(
        account(&env, &vault).await?.unwrap()["global_contract_hash"],
        code_before
    );
    assert_eq!(bal(&env, &vault).await?, 600 * MILLI);
    Ok(())
}
