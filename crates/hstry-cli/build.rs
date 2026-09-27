//! Stamp `--version` with the git commit so two builds of the same semver can
//! be told apart on every machine. Builds without git fall back to the semver.

use std::path::PathBuf;
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let build = match git(&["rev-parse", "--short=9", "HEAD"]) {
        Some(hash) => {
            let dirty =
                git(&["status", "--porcelain", "--untracked-files=no"]).map_or("", |_| "-dirty");
            let date = git(&["show", "-s", "--format=%cs", "HEAD"]).unwrap_or_default();
            format!("{version} ({hash}{dirty} {date})")
        }
        None => version.to_string(),
    };
    println!("cargo:rustc-env=HSTRY_BUILD_VERSION={build}");

    // Re-stamp when HEAD moves or the index changes (commit, checkout, stage).
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        let git_dir = PathBuf::from(git_dir);
        for file in ["HEAD", "index"] {
            println!("cargo:rerun-if-changed={}", git_dir.join(file).display());
        }
        if let Some(common) = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]) {
            let common = PathBuf::from(common);
            println!(
                "cargo:rerun-if-changed={}",
                common.join("packed-refs").display()
            );
            println!(
                "cargo:rerun-if-changed={}",
                common.join("refs/heads").display()
            );
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
