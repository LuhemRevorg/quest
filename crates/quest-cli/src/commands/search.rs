//! `quest search --term <t> --subject <s> --number <n>`.

use quest_core::config::Config;
use quest_core::model::search::{ClassSearch, RawSearch};
use quest_core::model::term::Term;
use quest_core::session::protocol::{LoginParams, Op, SearchParams};
use quest_core::session::Worker;
use quest_core::{credentials, paths, Error, Result};

use crate::cli::SearchArgs;
use crate::output::Out;

/// Fully non-interactive, like every data command.
pub fn search(args: &SearchArgs, out: Out) -> Result<ClassSearch> {
    let term: Term = args.term.parse()?;
    let subject = args.subject.trim().to_uppercase();
    let catalog_number = args.number.trim().to_owned();
    if subject.is_empty() || catalog_number.is_empty() {
        return Err(Error::Config(
            "--subject and --number are both required: Quest's class search needs at least two \
             criteria besides the term"
                .into(),
        ));
    }

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

    out.note(format!("searching {term} for {subject} {catalog_number}"));

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Search(SearchParams {
            login: LoginParams {
                profile_dir,
                username: Some(username),
                password: Some(password),
                duo_timeout_secs: args.timeout,
                display: args.display.into(),
                allow_human: false,
            },
            term_label: term.label(),
            term_code: term.code.to_string(),
            subject: subject.clone(),
            catalog_number: catalog_number.clone(),
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let raw: RawSearch = serde_json::from_value(data)?;
    Ok(raw.into_typed(term))
}

/// Human-readable listing. `--json` bypasses this entirely.
pub fn render(search: &ClassSearch) -> String {
    let mut lines = vec![format!(
        "{} — {} {}",
        search.term, search.subject, search.catalog_number
    )];

    if search.courses.is_empty() {
        lines.push(format!(
            "\n{}",
            search
                .message
                .as_deref()
                .unwrap_or("no classes match those criteria")
        ));
        return lines.join("\n");
    }

    for course in &search.courses {
        lines.push(String::new());
        let heading = match (&course.class, &course.description) {
            (Some(class), Some(description)) => format!("{class} — {description}"),
            (Some(class), None) => class.clone(),
            _ => "(untitled course)".to_owned(),
        };
        lines.push(heading);

        for section in &course.sections {
            let label = [section.section.as_deref(), section.component.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            lines.push(format!(
                "  {:<8} {:<6} {:<24} {:<14} {:<20} {}",
                if label.is_empty() { "-" } else { &label },
                section.class_number.as_deref().unwrap_or("-"),
                section.days_times.as_deref().unwrap_or("-"),
                section.room.as_deref().unwrap_or("-"),
                section.instructor.as_deref().unwrap_or("-"),
                section.status.as_deref().unwrap_or("-"),
            ));
        }
    }

    // Quest caps the result grid and says so in its own words; pass that on rather
    // than letting a truncated list read as the whole offering.
    if let Some(message) = &search.message {
        lines.push(format!("\n{message}"));
    }

    // A search for one course number usually returns exactly one course, so the
    // summary line is singular more often than not.
    let sections: usize = search.courses.iter().map(|c| c.sections.len()).sum();
    lines.push(format!(
        "\n{}, {}",
        plural(search.courses.len(), "course"),
        plural(sections, "section")
    ));
    lines.join("\n")
}

fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("{count} {noun}")
    } else {
        format!("{count} {noun}s")
    }
}
