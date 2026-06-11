module deep_pilot_log::log;

use sui::event;
use sui::object::{Self, UID};
use sui::string::String;
use sui::transfer;
use sui::tx_context::{Self, TxContext};

public struct IntentRecord has key, store {
    id: UID,
    user: address,
    intent_hash: String,
    action_type: String,
    venue: String,
    pair: String,
    risk_score: u64,
    risk_level: String,
    guardian_decision: String,
    tx_digest_reference: String,
    timestamp_ms: u64,
    sponsored: bool,
}

public struct RiskRecord has copy, drop {
    user: address,
    intent_hash: String,
    risk_score: u64,
    risk_level: String,
    guardian_decision: String,
    sponsored: bool,
}

public struct ExecutionRecord has copy, drop {
    user: address,
    intent_hash: String,
    tx_digest_reference: String,
    venue: String,
    sponsored: bool,
}

public fun record_intent(
    intent_hash: String,
    action_type: String,
    risk_level: String,
    risk_score: u64,
    sponsored: bool,
    ctx: &mut TxContext,
) {
    let user = tx_context::sender(ctx);
    let decision = if (risk_score >= 76) {
        b"block".to_string()
    } else if (risk_score >= 40) {
        b"warn".to_string()
    } else {
        b"allow".to_string()
    };

    event::emit(RiskRecord {
        user,
        intent_hash,
        risk_score,
        risk_level,
        guardian_decision: decision,
        sponsored,
    });
}

public fun create_intent_record(
    intent_hash: String,
    action_type: String,
    venue: String,
    pair: String,
    risk_score: u64,
    risk_level: String,
    guardian_decision: String,
    tx_digest_reference: String,
    timestamp_ms: u64,
    sponsored: bool,
    ctx: &mut TxContext,
) {
    let record = IntentRecord {
        id: object::new(ctx),
        user: tx_context::sender(ctx),
        intent_hash,
        action_type,
        venue,
        pair,
        risk_score,
        risk_level,
        guardian_decision,
        tx_digest_reference,
        timestamp_ms,
        sponsored,
    };

    transfer::transfer(record, tx_context::sender(ctx));
}

public fun emit_execution(
    intent_hash: String,
    tx_digest_reference: String,
    venue: String,
    sponsored: bool,
    ctx: &mut TxContext,
) {
    event::emit(ExecutionRecord {
        user: tx_context::sender(ctx),
        intent_hash,
        tx_digest_reference,
        venue,
        sponsored,
    });
}

