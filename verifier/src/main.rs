//! The program OutLayer runs: reads one input from stdin and prints the verdict to stdout.
//! See `run.rs` for the input and output formats.

use std::io::{Read, Write};

fn main() {
    let mut input = Vec::new();
    let verdict = match std::io::stdin().read_to_end(&mut input) {
        Ok(_) => proven_verifier::run::run(&input),
        Err(_) => r#"{"error":"unreadable_input","v":1}"#.to_string(),
    };
    let mut stdout = std::io::stdout();
    stdout.write_all(verdict.as_bytes()).expect("write verdict");
    stdout.flush().expect("flush verdict");
}
