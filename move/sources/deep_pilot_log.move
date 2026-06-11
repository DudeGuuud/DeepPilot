module deep_pilot_log::log;

use sui::event;
use sui::tx_context::{Self, TxContext};
use std::string::{Self, String};

public struct RiskRecord has copy, drop {
    user: address,
    intent_hash: String,
    risk_score: u64,
    guardian_decision: String,
    sponsored: bool,
}

public fun record_intent(
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
