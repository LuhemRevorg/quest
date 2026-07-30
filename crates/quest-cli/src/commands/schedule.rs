//! `quest schedule --term <t>`.

use quest_core::config::Config;
use quest_core::model::schedule::{RawSchedule, TermSchedule};
use quest_core::model::term::Term;
use quest_core::session::protocol::{LoginParams, Op, ScheduleParams};
use quest_core::session::Worker;
use quest_core::{credentials, paths, Error, Result};

use crate::cli::ScheduleArgs;
use crate::output::Out;

/// Fully non-interactive, like every data command.
pub fn schedule(args: &ScheduleArgs, out: Out) -> Result<TermSchedule> {
    let term: Term = args.term.parse()?;
    let config = Config::load()?;

    let username = config.username.clone().ok_or_else(|| {
        Error::NeedsReauth("no username on record — run `quest auth login`".into())
    })?;
    let password = credentials::get_password_non_blocking(&username)?.ok_or_else(|| {
        Error::NeedsReauth(
            "no stored password — run `quest auth login --save-password` to enable \
             unattended access"
                .into(),
        )
    })?;

    let profile_dir = config.resolved_profile_dir()?;
    paths::ensure_private_dir(&profile_dir)?;

    out.note(format!("fetching class schedule for {term}"));

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Schedule(ScheduleParams {
            login: LoginParams {
                profile_dir,
                username: Some(username),
                password: Some(password),
                duo_timeout_secs: args.timeout,
                display: args.display.into(),
                allow_human: false,
            },
            term_label: term.label(),
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let raw: RawSchedule = serde_json::from_value(data)?;
    Ok(raw.into_typed(term))
}

/// Human-readable listing. `--json` bypasses this entirely.
pub fn render(schedule: &TermSchedule) -> String {
    let mut lines = vec![format!("{}", schedule.term)];

    if schedule.courses.is_empty() {
        lines.push("\nnot enrolled in any classes this term".to_owned());
        return lines.join("\n");
    }

    for course in &schedule.courses {
        lines.push(String::new());
        let heading = match (&course.class, &course.description) {
            (Some(class), Some(description)) => format!("{class} — {description}"),
            (Some(class), None) => class.clone(),
            _ => "(untitled course)".to_owned(),
        };
        lines.push(heading);

        let mut facts = Vec::new();
        if let Some(status) = &course.status {
            facts.push(status.clone());
        }
        if let Some(units) = course.units {
            facts.push(format!("{units:.2} units"));
        }
        if let Some(basis) = &course.grading_basis {
            facts.push(basis.clone());
        }
        if !facts.is_empty() {
            lines.push(format!("  {}", facts.join(" · ")));
        }

        for meeting in &course.meetings {
            let section = [meeting.component.as_deref(), meeting.section.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            lines.push(format!(
                "  {:<10} {:<22} {:<16} {}",
                if section.is_empty() { "-" } else { &section },
                meeting.days_times.as_deref().unwrap_or("-"),
                meeting.room.as_deref().unwrap_or("-"),
                meeting.instructor.as_deref().unwrap_or("-"),
            ));
        }
    }

    let units: f64 = schedule.courses.iter().filter_map(|c| c.units).sum();
    lines.push(format!(
        "\n{} courses, {units:.2} units",
        schedule.courses.len()
    ));
    lines.join("\n")
}
