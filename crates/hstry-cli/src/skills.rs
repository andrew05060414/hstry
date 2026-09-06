//! Thin proxy from `chronicle skills` to Andrew-Skill / skill-management.
//! Skills live in Andrew-Skill; this crate does not copy SKILL.md files.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};

use anyhow::{Context, Result, bail};
use which::which;

const DEFAULT_SKILL_ROOT: &str = r"D:\Andrew\Code\Github\Andrew-Skill";

#[derive(Debug, clap::Subcommand)]
pub enum SkillsCommand {
    /// Run skill-management inventory audit
    Audit,
    /// List published skills (`asm list`, fallback `asm stats`)
    List,
    /// Dry-run sync-all.ps1 unless `--apply`
    Sync {
        /// Write links / publish (default is dry-run)
        #[arg(long)]
        apply: bool,
    },
    /// New-machine host env (apply-host-env.ps1). Not a memory-bus node.
    Bootstrap {
        /// Apply host env (default is dry-run)
        #[arg(long)]
        apply: bool,
    },
}

pub fn run(command: SkillsCommand) -> Result<()> {
    let root = skill_root()?;
    match command {
        SkillsCommand::Audit => run_pwsh(
            &root
                .join("skill-management")
                .join("scripts")
                .join("audit-inventory.ps1"),
            &[],
        ),
        SkillsCommand::List => run_asm_list(),
        SkillsCommand::Sync { apply } => {
            let script = root
                .join("skill-management")
                .join("scripts")
                .join("sync-all.ps1");
            if apply {
                run_pwsh(&script, &["-Apply"])
            } else {
                run_pwsh(&script, &[])
            }
        }
        SkillsCommand::Bootstrap { apply } => {
            let script = root
                .join("skill-management")
                .join("scripts")
                .join("apply-host-env.ps1");
            if apply {
                run_pwsh(&script, &["-Apply"])
            } else {
                run_pwsh(&script, &[])
            }
        }
    }
}

fn skill_root() -> Result<PathBuf> {
    if let Ok(p) = env::var("CHRONICLE_SKILL_ROOT") {
        let path = PathBuf::from(p);
        if path.is_dir() {
            return Ok(path);
        }
        bail!(
            "CHRONICLE_SKILL_ROOT is not a directory: {}",
            path.display()
        );
    }
    let default = PathBuf::from(DEFAULT_SKILL_ROOT);
    if default.is_dir() {
        return Ok(default);
    }
    bail!(
        "Andrew-Skill root not found at {}; set CHRONICLE_SKILL_ROOT",
        default.display()
    );
}

fn pwsh() -> Result<PathBuf> {
    which("pwsh")
        .or_else(|_| which("powershell"))
        .context("pwsh/powershell not found on PATH")
}

fn run_pwsh(script: &Path, extra: &[&str]) -> Result<()> {
    if !script.is_file() {
        bail!("script not found: {}", script.display());
    }
    let status = ProcessCommand::new(pwsh()?)
        .arg("-NoProfile")
        .arg("-File")
        .arg(script)
        .args(extra)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("failed to spawn {}", script.display()))?;
    if status.success() {
        Ok(())
    } else {
        bail!("{} exited with {status}", script.display());
    }
}

fn run_asm_list() -> Result<()> {
    let asm = match which("asm") {
        Ok(p) => p,
        Err(_) => {
            bail!("asm not found on PATH; install ASM or use `chronicle skills audit`");
        }
    };
    for args in [vec!["list"], vec!["stats"]] {
        let status = ProcessCommand::new(&asm)
            .args(&args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .with_context(|| format!("failed to spawn {} {}", asm.display(), args.join(" ")))?;
        if status.success() {
            return Ok(());
        }
    }
    bail!("asm list and asm stats both failed");
}

pub fn run_tui() -> Result<()> {
    for name in ["chronicle-tui", "hstry-tui"] {
        if let Ok(path) = which(name) {
            let status = ProcessCommand::new(&path)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .with_context(|| format!("failed to spawn {name}"))?;
            if status.success() {
                return Ok(());
            }
            bail!("{name} exited with {status}");
        }
    }
    bail!("neither chronicle-tui nor hstry-tui is on PATH; cargo install --path crates/hstry-tui");
}
