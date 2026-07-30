//! `quest grades --term <t>`.

use quest_core::config::Config;
use quest_core::model::grades::{RawTermGrades, TermGrades};
use quest_core::model::term::Term;
use quest_core::session::protocol::{GradesParams, LoginParams, Op};
use quest_core::session::Worker;
use quest_core::{credentials, paths, Error, Result};

use crate::cli::GradesArgs;
use crate::output::Out;

/// Fully non-interactive, like every data command: it authenticates using the
/// keychain password and Duo device trust, and turns "a human is required" into
/// [`Error::NeedsReauth`] → exit 77 rather than prompting or hanging.
pub fn grades(args: &GradesArgs, out: Out) -> Result<TermGrades> {
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

    out.note(format!("fetching grades for {term}"));

    let mut worker = Worker::spawn()?;
    let data = worker.call(
        Op::Grades(GradesParams {
            login: LoginParams {
                profile_dir,
                username: Some(username),
                password: Some(password),
                duo_timeout_secs: args.timeout,
                display: args.display.into(),
                allow_human: false,
            },
            // Quest matches on its own label, not the numeric code.
            term_label: term.label(),
        }),
        &mut |_stage, message| out.note(format!("  {message}")),
    )?;

    let raw: RawTermGrades = serde_json::from_value(data)?;
    Ok(raw.into_typed(term))
}

/// Human-readable table. `--json` bypasses this entirely.
pub fn render(grades: &TermGrades) -> String {
    let mut lines = vec![format!("{}", grades.term)];
    if let Some(standing) = &grades.academic_standing {
        lines.push(format!("standing: {standing}"));
    }
    if grades.courses.is_empty() {
        lines.push("\nno courses found for this term".to_owned());
        return lines.join("\n");
    }

    lines.push(String::new());
    lines.push(format!(
        "{:<12} {:<34} {:>6} {:>6} {:>7}",
        "CLASS", "DESCRIPTION", "UNITS", "GRADE", "POINTS"
    ));
    for course in &grades.courses {
        lines.push(format!(
            "{:<12} {:<34} {:>6} {:>6} {:>7}",
            course.class.as_deref().unwrap_or("-"),
            truncate(course.description.as_deref().unwrap_or("-"), 34),
            course
                .units
                .map(|u| format!("{u:.2}"))
                .unwrap_or_else(|| "-".into()),
            course.grade.as_deref().unwrap_or("-"),
            course
                .grade_points
                .map(|p| format!("{p:.2}"))
                .unwrap_or_else(|| "-".into()),
        ));
    }

    let units: f64 = grades.courses.iter().filter_map(|c| c.units).sum();
    let points: f64 = grades.courses.iter().filter_map(|c| c.grade_points).sum();
    lines.push(format!(
        "\n{} courses, {units:.2} units, {points:.2} grade points",
        grades.courses.len()
    ));
    lines.join("\n")
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}
