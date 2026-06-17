module deep_pilot_profile::profile;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::sui::SUI;
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use sui::vec_map::{Self, VecMap};

const PLAN_STANDARD: u8 = 0;
const PLAN_PRO: u8 = 1;
const PLAN_MAX: u8 = 2;
const PLAN_PRICE_MIST: u64 = 100_000_000;
const PLAN_DURATION_MS: u64 = 2_592_000_000;
const QUOTA_POLICY_VERSION: u64 = 1;
const DEMO_QUOTA_LIMIT: u64 = 50;

const E_DUPLICATE_TELEGRAM_HASH: u64 = 1;
const E_DUPLICATE_WALLET: u64 = 2;
const E_INVALID_PLAN: u64 = 3;
const E_INVALID_PAYMENT: u64 = 4;
const E_NOT_OWNER: u64 = 5;
const E_INSUFFICIENT_TREASURY: u64 = 6;

public struct ProfileAdminCap has key {
    id: UID,
}

public struct Registry has key {
    id: UID,
    telegram_profiles: VecMap<vector<u8>, ID>,
    wallet_profiles: VecMap<address, ID>,
}

public struct Treasury has key {
    id: UID,
    balance: Balance<SUI>,
}

public struct Profile has key, store {
    id: UID,
    owner: address,
    telegram_hash: vector<u8>,
    plan: u8,
    plan_expires_at_ms: u64,
    quota_policy_version: u64,
    quota_limit_snapshot: u64,
    quota_day_snapshot: u64,
    quota_used_snapshot: u64,
    memory_account_id: String,
    memory_namespace: String,
    memory_root_blob_id: String,
    created_at_ms: u64,
    updated_at_ms: u64,
}

public struct ProfileCreated has copy, drop {
    owner: address,
    profile_id: ID,
    telegram_hash: vector<u8>,
    plan: u8,
    quota_limit_snapshot: u64,
    memory_namespace: String,
}

public struct PlanChanged has copy, drop {
    profile_id: ID,
    owner: address,
    plan: u8,
    expires_at_ms: u64,
    admin_override: bool,
}

public struct MemoryPointerUpdated has copy, drop {
    profile_id: ID,
    owner: address,
    memory_account_id: String,
    memory_namespace: String,
    memory_root_blob_id: String,
}

public struct TreasuryWithdrawn has copy, drop {
    amount: u64,
    recipient: address,
}

fun init(ctx: &mut TxContext) {
    let registry = Registry {
        id: object::new(ctx),
        telegram_profiles: vec_map::empty(),
        wallet_profiles: vec_map::empty(),
    };
    let treasury = Treasury {
        id: object::new(ctx),
        balance: balance::zero(),
    };

    transfer::share_object(registry);
    transfer::share_object(treasury);
    transfer::transfer(ProfileAdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
}

#[allow(lint(self_transfer))]
public fun create_profile(
    registry: &mut Registry,
    telegram_hash: vector<u8>,
    memory_namespace: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let owner = tx_context::sender(ctx);
    assert!(!registry.telegram_profiles.contains(&telegram_hash), E_DUPLICATE_TELEGRAM_HASH);
    assert!(!registry.wallet_profiles.contains(&owner), E_DUPLICATE_WALLET);

    let now = clock::timestamp_ms(clock);
    let profile = Profile {
        id: object::new(ctx),
        owner,
        telegram_hash,
        plan: PLAN_STANDARD,
        plan_expires_at_ms: 0,
        quota_policy_version: QUOTA_POLICY_VERSION,
        quota_limit_snapshot: DEMO_QUOTA_LIMIT,
        quota_day_snapshot: 0,
        quota_used_snapshot: 0,
        memory_account_id: std::string::utf8(b""),
        memory_namespace,
        memory_root_blob_id: std::string::utf8(b""),
        created_at_ms: now,
        updated_at_ms: now,
    };
    let profile_id = object::id(&profile);

    registry.telegram_profiles.insert(profile.telegram_hash, profile_id);
    registry.wallet_profiles.insert(owner, profile_id);

    event::emit(ProfileCreated {
        owner,
        profile_id,
        telegram_hash: profile.telegram_hash,
        plan: profile.plan,
        quota_limit_snapshot: profile.quota_limit_snapshot,
        memory_namespace: profile.memory_namespace,
    });

    transfer::transfer(profile, owner);
}

public fun subscribe(
    profile: &mut Profile,
    treasury: &mut Treasury,
    plan: u8,
    payment: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_owner(profile, ctx);
    assert_valid_paid_plan(plan);
    assert!(coin::value(&payment) == PLAN_PRICE_MIST, E_INVALID_PAYMENT);

    treasury.balance.join(coin::into_balance(payment));

    let now = clock::timestamp_ms(clock);
    profile.plan = plan;
    profile.plan_expires_at_ms = now + PLAN_DURATION_MS;
    profile.updated_at_ms = now;

    event::emit(PlanChanged {
        profile_id: object::id(profile),
        owner: profile.owner,
        plan,
        expires_at_ms: profile.plan_expires_at_ms,
        admin_override: false,
    });
}

public fun admin_set_plan(
    _: &ProfileAdminCap,
    profile: &mut Profile,
    plan: u8,
    expires_at_ms: u64,
    clock: &Clock,
) {
    assert_valid_plan(plan);

    profile.plan = plan;
    profile.plan_expires_at_ms = expires_at_ms;
    profile.updated_at_ms = clock::timestamp_ms(clock);

    event::emit(PlanChanged {
        profile_id: object::id(profile),
        owner: profile.owner,
        plan,
        expires_at_ms,
        admin_override: true,
    });
}

public fun set_memory_pointer(
    profile: &mut Profile,
    memory_account_id: String,
    memory_namespace: String,
    memory_root_blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_owner(profile, ctx);

    profile.memory_account_id = memory_account_id;
    profile.memory_namespace = memory_namespace;
    profile.memory_root_blob_id = memory_root_blob_id;
    profile.updated_at_ms = clock::timestamp_ms(clock);

    event::emit(MemoryPointerUpdated {
        profile_id: object::id(profile),
        owner: profile.owner,
        memory_account_id: profile.memory_account_id,
        memory_namespace: profile.memory_namespace,
        memory_root_blob_id: profile.memory_root_blob_id,
    });
}

public fun admin_withdraw(
    _: &ProfileAdminCap,
    treasury: &mut Treasury,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    assert!(balance::value(&treasury.balance) >= amount, E_INSUFFICIENT_TREASURY);

    let coin = coin::take(&mut treasury.balance, amount, ctx);
    transfer::public_transfer(coin, recipient);

    event::emit(TreasuryWithdrawn { amount, recipient });
}

fun assert_owner(profile: &Profile, ctx: &TxContext) {
    assert!(profile.owner == tx_context::sender(ctx), E_NOT_OWNER);
}

fun assert_valid_plan(plan: u8) {
    assert!(plan == PLAN_STANDARD || plan == PLAN_PRO || plan == PLAN_MAX, E_INVALID_PLAN);
}

fun assert_valid_paid_plan(plan: u8) {
    assert!(plan == PLAN_PRO || plan == PLAN_MAX, E_INVALID_PLAN);
}
