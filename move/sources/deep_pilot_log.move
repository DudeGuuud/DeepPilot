module deep_pilot_log::log;

use sui::event;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use std::string::{Self, String};

public struct LogAdminCap has key {
    id: UID,
}

public struct RiskRecord has copy, drop {
    user: address,
    intent_hash: String,
    risk_score: u64,
    guardian_decision: String,
    sponsored: bool,
}

fun init(ctx: &mut TxContext) {
    transfer::transfer(LogAdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
}

public fun record_intent(
    _: &LogAdminCap,
    intent_hash: String,
    risk_score: u64,
    sponsored: bool,
    ctx: &mut TxContext,
) {
    let decision = if (risk_score >= 76) {
        string::utf8(b"block")
    } else if (risk_score >= 40) {
        string::utf8(b"reduce")
    } else {
        string::utf8(b"allow")
    };

    event::emit(RiskRecord {
        user: tx_context::sender(ctx),
        intent_hash,
        risk_score,
        guardian_decision: decision,
        sponsored,
    });
}
