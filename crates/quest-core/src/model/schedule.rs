//! The classes enrolled in for one term.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::term::Term;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermSchedule {
    pub schema_version: u32,
    pub term: Term,
    /// Quest's own label for the term it rendered, so a consumer can see the page
    /// agreed with the request rather than trusting us.
    pub term_shown: Option<String>,
    pub courses: Vec<EnrolledCourse>,
    pub retrieved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrolledCourse {
    /// e.g. `"EFGH 200"`, split from the title Quest renders.
    pub class: Option<String>,
    /// e.g. `"Second Placeholder Course"`.
    pub description: Option<String>,
    /// `"Enrolled"`, `"Dropped"`, `"Waitlisted"`.
    pub status: Option<String>,
    pub units: Option<f64>,
    pub grading_basis: Option<String>,
    /// A course may meet several times — a lecture plus a tutorial, say.
    pub meetings: Vec<Meeting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub class_number: Option<String>,
    pub section: Option<String>,
    /// `"LEC"`, `"TUT"`, `"LAB"`, `"WRK"` for a work term.
    pub component: Option<String>,
    /// Free text, and often `"TBA"`.
    pub days_times: Option<String>,
    pub room: Option<String>,
    pub instructor: Option<String>,
    pub start_end: Option<String>,
}

/// What the worker sends back, before typing. Field names mirror
/// `worker/src/schedule.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawSchedule {
    pub term_requested: String,
    pub term_shown: Option<String>,
    pub courses: Vec<RawCourse>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawCourse {
    /// The whole group-divider line, e.g. `"EFGH 200 - Second Placeholder Course"`.
    pub title: Option<String>,
    pub status: Option<String>,
    pub units: Option<String>,
    pub grading_basis: Option<String>,
    pub meetings: Vec<Meeting>,
}

impl RawSchedule {
    pub fn into_typed(self, term: Term) -> TermSchedule {
        TermSchedule {
            schema_version: super::SCHEMA_VERSION,
            term,
            term_shown: self.term_shown,
            courses: self
                .courses
                .into_iter()
                .map(|raw| {
                    let (class, description) = split_title(raw.title.as_deref());
                    EnrolledCourse {
                        class,
                        description,
                        status: raw.status,
                        units: raw.units.as_deref().and_then(|u| u.trim().parse().ok()),
                        grading_basis: raw.grading_basis,
                        meetings: raw.meetings,
                    }
                })
                .collect(),
            retrieved_at: Utc::now(),
        }
    }
}

/// Quest renders `"EFGH 200 - Second Placeholder Course"`. Split on the first ` - ` only:
/// course titles contain hyphens of their own ("Placeholder Work-Study Course"), so a
/// greedy split would mangle them.
///
/// Shared with [`crate::model::search`], whose result headings are the same shape.
pub(crate) fn split_title(title: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) else {
        return (None, None);
    };
    match title.split_once(" - ") {
        Some((class, description)) => (
            Some(class.trim().to_owned()),
            Some(description.trim().to_owned()),
        ),
        // No separator: keep the whole thing as the class rather than losing it.
        None => (Some(title.to_owned()), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::term::Season;

    fn raw(title: Option<&str>, units: Option<&str>) -> RawSchedule {
        RawSchedule {
            term_requested: "Spring 2026".into(),
            term_shown: Some("Spring 2026".into()),
            courses: vec![RawCourse {
                title: title.map(str::to_owned),
                status: Some("Enrolled".into()),
                units: units.map(str::to_owned),
                grading_basis: Some("Numeric Grading Basis".into()),
                meetings: vec![],
            }],
        }
    }

    #[test]
    fn splits_class_from_description() {
        let typed = raw(Some("EFGH 200 - Second Placeholder Course"), Some("0.50"))
            .into_typed(Term::new(Season::Spring, 2026));
        assert_eq!(typed.courses[0].class.as_deref(), Some("EFGH 200"));
        assert_eq!(
            typed.courses[0].description.as_deref(),
            Some("Second Placeholder Course")
        );
        assert_eq!(typed.courses[0].units, Some(0.5));
    }

    /// Titles contain their own hyphens; only the first separator is a boundary.
    #[test]
    fn keeps_hyphenated_titles_intact() {
        let typed = raw(Some("ABCD 100 - Placeholder Work-Study Course"), None)
            .into_typed(Term::new(Season::Spring, 2026));
        assert_eq!(typed.courses[0].class.as_deref(), Some("ABCD 100"));
        assert_eq!(
            typed.courses[0].description.as_deref(),
            Some("Placeholder Work-Study Course")
        );
    }

    #[test]
    fn tolerates_a_title_without_a_separator() {
        let typed = raw(Some("SOMETHING ODD"), None).into_typed(Term::new(Season::Spring, 2026));
        assert_eq!(typed.courses[0].class.as_deref(), Some("SOMETHING ODD"));
        assert_eq!(typed.courses[0].description, None);
    }

    #[test]
    fn tolerates_missing_fields() {
        let typed = raw(None, Some("")).into_typed(Term::new(Season::Spring, 2026));
        assert_eq!(typed.courses[0].class, None);
        assert_eq!(typed.courses[0].units, None);
        assert_eq!(typed.courses[0].status.as_deref(), Some("Enrolled"));
    }
}
