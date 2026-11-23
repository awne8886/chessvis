// The search recurses deeply (128 plies, large frames): give it a 16 MiB stack, as the shipped web build has
// (wasm32-unknown-unknown defaults to 1 MiB).
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=aggro.nnue");
    println!("cargo:rerun-if-changed=aggro-ocb.nnue");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=-zstack-size=16777216");
    }
}
