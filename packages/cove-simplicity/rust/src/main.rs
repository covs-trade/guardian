











use simfony::parse::ParseFromStr;
use simfony::simplicity::BitMachine;
use simfony::simplicity::HasCmr;


const MINT_SIMFONY: &str = r#"
fn main() {
    let amount: u64 = witness::AMOUNT;
    let prev_supply: u64 = witness::PREV_SUPPLY;
    let next_supply: u64 = witness::NEXT_SUPPLY;
    let prev_reserve: u64 = witness::PREV_RESERVE;
    let next_reserve: u64 = witness::NEXT_RESERVE;
    let contribution: u64 = witness::CONTRIBUTION;


    let (carry, sum_supply): (bool, u64) = jet::add_64(prev_supply, amount);
    assert!(jet::le_64(prev_supply, sum_supply));
    assert!(jet::eq_64(sum_supply, next_supply));

    assert!(jet::le_64(next_supply, 21_000_000));

    assert!(jet::lt_64(0, amount));

    let (carry2, sum_reserve): (bool, u64) = jet::add_64(prev_reserve, contribution);
    assert!(jet::le_64(prev_reserve, sum_reserve));
    assert!(jet::eq_64(sum_reserve, next_reserve));
}
"#;


const REDEEM_SIMFONY: &str = r#"
fn main() {
    let amount: u64 = witness::AMOUNT;
    let old_supply: u64 = witness::OLD_SUPPLY;
    let new_supply: u64 = witness::NEW_SUPPLY;
    let old_backing: u64 = witness::OLD_BACKING;
    let new_backing: u64 = witness::NEW_BACKING;
    let payout: u64 = witness::PAYOUT;


    assert!(jet::lt_64(0, amount));

    assert!(jet::le_64(amount, old_supply));

    let (borrow, diff): (bool, u64) = jet::subtract_64(old_supply, amount);
    assert!(jet::eq_64(diff, new_supply));

    assert!(jet::le_64(payout, old_backing));
    let (borrow2, diff2): (bool, u64) = jet::subtract_64(old_backing, payout);
    assert!(jet::eq_64(diff2, new_backing));
}
"#;

#[derive(serde::Serialize)]
struct BuildOutput {
    cmr: String,
    program: String,
}

#[derive(serde::Serialize)]
struct ExecOutput {
    cmr: String,
    result: String,
}

fn source_for(policy: &str) -> &'static str {
    match policy {
        "mint" => MINT_SIMFONY,
        "redeem" => REDEEM_SIMFONY,
        other => {
            eprintln!("unknown policy: {other} (expected mint|redeem)");
            std::process::exit(2);
        }
    }
}

fn compiled(policy: &str) -> Result<simfony::CompiledProgram, String> {
    simfony::CompiledProgram::new(source_for(policy), simfony::Arguments::default())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("build");
    let policy = args.get(2).map(String::as_str).unwrap_or("mint");

    match mode {
        "build" => {
            let program = compiled(policy).expect("Simfony compilation failed");
            let cmr = program.commit().cmr();
            let bytes = program.commit().encode_to_vec();
            use base64::Engine;
            let out = BuildOutput {
                cmr: hex::encode(cmr.to_byte_array()),
                program: base64::engine::general_purpose::STANDARD.encode(bytes),
            };
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        "exec" => {
            let witness_str = args
                .get(3)
                .expect("usage: cove-simplicity exec <mint|redeem> '<mod witness {...}>'");
            let program = compiled(policy).expect("Simfony compilation failed");
            let cmr = program.commit().cmr();
            let witness = simfony::WitnessValues::parse_from_str(witness_str)
                .expect("invalid witness values");
            let satisfied = match program.satisfy(witness) {
                Ok(s) => s,
                Err(_) => {
                    let out = ExecOutput {
                        cmr: hex::encode(cmr.to_byte_array()),
                        result: "FAIL".to_string(),
                    };
                    println!("{}", serde_json::to_string(&out).unwrap());
                    return;
                }
            };
            let redeem = satisfied.redeem();
            let env = simfony::dummy_env::dummy();
            let pruned = match redeem.prune(&env) {
                Ok(p) => p,
                Err(_) => {
                    let out = ExecOutput {
                        cmr: hex::encode(cmr.to_byte_array()),
                        result: "FAIL".to_string(),
                    };
                    println!("{}", serde_json::to_string(&out).unwrap());
                    return;
                }
            };
            let mut mac = match BitMachine::for_program(pruned.as_ref()) {
                Ok(m) => m,
                Err(_) => {
                    let out = ExecOutput {
                        cmr: hex::encode(cmr.to_byte_array()),
                        result: "FAIL".to_string(),
                    };
                    println!("{}", serde_json::to_string(&out).unwrap());
                    return;
                }
            };
            let result = match mac.exec(pruned.as_ref(), &env) {
                Ok(_) => "PASS",
                Err(_) => "FAIL",
            };
            let out = ExecOutput {
                cmr: hex::encode(cmr.to_byte_array()),
                result: result.to_string(),
            };
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        other => {
            eprintln!("unknown mode: {other}");
            std::process::exit(2);
        }
    }
}
