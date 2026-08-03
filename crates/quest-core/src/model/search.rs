//! The sections of one course offered in one term.
//!
//! This is the catalog, not the student record: it answers "when does CS 246 run
//! in the fall", enrolled or not. [`crate::model::schedule`] answers the other
//! question.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::schedule::split_title;
use super::term::Term;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassSearch {
    pub schema_version: u32,
    pub term: Term,
    /// Quest's own label for the term it searched, so a consumer can see the page
    /// agreed with the request rather than trusting us.
    pub term_shown: Option<String>,
    /// The criteria, echoed back. A search is only meaningful alongside them.
    pub subject: String,
    pub catalog_number: String,
    /// Quest's own message, e.g. when nothing matched. Null when it said nothing.
    pub message: Option<String>,
    pub courses: Vec<SearchCourse>,
    pub retrieved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchCourse {
    /// e.g. `"CS 246"`, split from the heading Quest renders.
    pub class: Option<String>,
    /// e.g. `"Object-Oriented Software Development"`.
    pub description: Option<String>,
    pub sections: Vec<ClassSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassSection {
    /// The five-digit number you actually enrol with.
    pub class_number: Option<String>,
    /// e.g. `"001"`.
    pub section: Option<String>,
    /// `"LEC"`, `"TUT"`, `"LAB"`, `"TST"`.
    pub component: Option<String>,
    /// Free text, and often `"TBA"`.
    pub days_times: Option<String>,
    pub room: Option<String>,
    pub instructor: Option<String>,
    pub meeting_dates: Option<String>,
    /// `"Open"`, `"Closed"`, `"Wait List"` — from the status icon, so it is only as
    /// fresh as the page.
    pub status: Option<String>,
}

/// What the worker sends back, before typing. Field names mirror
/// `worker/src/search.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawSearch {
    pub term_requested: String,
    pub term_shown: Option<String>,
    pub subject: String,
    pub catalog_number: String,
    pub message: Option<String>,
    pub courses: Vec<RawSearchCourse>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSearchCourse {
    /// The whole heading, e.g. `"CS 246 - Object-Oriented Software Development"`.
    pub title: Option<String>,
    pub sections: Vec<RawSection>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSection {
    pub class_number: Option<String>,
    /// The section link's text, e.g. `"001-LEC Regular"` — sometimes with the class
    /// number in parentheses.
    pub class_name: Option<String>,
    pub days_times: Option<String>,
    pub room: Option<String>,
    pub instructor: Option<String>,
    pub meeting_dates: Option<String>,
    pub status: Option<String>,
}

impl RawSearch {
    pub fn into_typed(self, term: Term) -> ClassSearch {
        ClassSearch {
            schema_version: super::SCHEMA_VERSION,
            term,
            term_shown: self.term_shown,
            subject: self.subject,
            catalog_number: self.catalog_number,
            message: self.message,
            courses: self
                .courses
                .into_iter()
                .map(|raw| {
                    let (class, description) = split_title(raw.title.as_deref());
                    SearchCourse {
                        class,
                        description,
                        sections: raw.sections.into_iter().map(ClassSection::from).collect(),
                    }
                })
                .collect(),
            retrieved_at: Utc::now(),
        }
    }
}

impl From<RawSection> for ClassSection {
    fn from(raw: RawSection) -> Self {
        let (section, component) = split_class_name(raw.class_name.as_deref());
        Self {
            // Quest shows the class number in its own cell on some pages and only
            // in the section link's text on others; take whichever is there.
            class_number: raw
                .class_number
                .or_else(|| class_number_in(raw.class_name.as_deref())),
            section,
            component,
            days_times: raw.days_times,
            room: raw.room,
            instructor: raw.instructor,
            meeting_dates: raw.meeting_dates,
            status: raw.status,
        }
    }
}

/// `"001-LEC Regular"` -> (`"001"`, `"LEC"`).
///
/// Anything that does not look like that is kept whole as the section rather than
/// being dropped — a section label we cannot parse is still a section label.
fn split_class_name(name: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return (None, None);
    };
    // Only the leading `<section>-<component>` token; the rest is "Regular",
    // "Essay", or the class number in parentheses.
    let head = name.split_whitespace().next().unwrap_or(name);
    match head.split_once('-') {
        Some((section, component)) if !section.is_empty() && !component.is_empty() => (
            Some(section.to_owned()),
            Some(component.trim_end_matches(&['(', ')'][..]).to_owned()),
        ),
        _ => (Some(name.to_owned()), None),
    }
}

/// The `(4382)` some deployments append to the section link.
fn class_number_in(name: Option<&str>) -> Option<String> {
    let name = name?;
    let start = name.find('(')?;
    let end = name[start..].find(')')? + start;
    let inner = name[start + 1..end].trim();
    inner
        .chars()
        .all(|c| c.is_ascii_digit())
        .then(|| inner.to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::term::Season;

    fn section(class_name: Option<&str>, class_number: Option<&str>) -> RawSection {
        RawSection {
            class_number: class_number.map(str::to_owned),
            class_name: class_name.map(str::to_owned),
            days_times: Some("MWF 10:30AM - 11:20AM".into()),
            room: Some("MC 4021".into()),
            instructor: Some("Instructor Name".into()),
            meeting_dates: Some("09/08/2026 - 12/07/2026".into()),
            status: Some("Open".into()),
        }
    }

    fn raw(sections: Vec<RawSection>) -> RawSearch {
        RawSearch {
            term_requested: "Fall 2026".into(),
            term_shown: Some("Fall 2026".into()),
            subject: "CS".into(),
            catalog_number: "246".into(),
            message: None,
            courses: vec![RawSearchCourse {
                title: Some("CS 246 - Placeholder Course Title".into()),
                sections,
            }],
        }
    }

    #[test]
    fn splits_the_course_heading() {
        let typed = raw(vec![]).into_typed(Term::new(Season::Fall, 2026));
        assert_eq!(typed.courses[0].class.as_deref(), Some("CS 246"));
        assert_eq!(
            typed.courses[0].description.as_deref(),
            Some("Placeholder Course Title")
        );
    }

    #[test]
    fn splits_section_from_component() {
        let typed = raw(vec![section(Some("001-LEC Regular"), Some("4382"))])
            .into_typed(Term::new(Season::Fall, 2026));
        let first = &typed.courses[0].sections[0];
        assert_eq!(first.section.as_deref(), Some("001"));
        assert_eq!(first.component.as_deref(), Some("LEC"));
        assert_eq!(first.class_number.as_deref(), Some("4382"));
        assert_eq!(first.status.as_deref(), Some("Open"));
    }

    /// Some markup puts the class number in the link text instead of its own cell.
    #[test]
    fn recovers_a_parenthesised_class_number() {
        let typed = raw(vec![section(Some("002-TUT (4383)"), None)])
            .into_typed(Term::new(Season::Fall, 2026));
        let first = &typed.courses[0].sections[0];
        assert_eq!(first.class_number.as_deref(), Some("4383"));
        assert_eq!(first.section.as_deref(), Some("002"));
        assert_eq!(first.component.as_deref(), Some("TUT"));
    }

    /// A label we cannot split is kept, not dropped.
    #[test]
    fn tolerates_an_unsplittable_section_label() {
        let typed =
            raw(vec![section(Some("ONLINE"), None)]).into_typed(Term::new(Season::Fall, 2026));
        let first = &typed.courses[0].sections[0];
        assert_eq!(first.section.as_deref(), Some("ONLINE"));
        assert_eq!(first.component, None);
        assert_eq!(first.class_number, None);
    }

    #[test]
    fn keeps_the_message_when_nothing_matched() {
        let mut empty = raw(vec![]);
        empty.courses = vec![];
        empty.message = Some("The search returns no results.".into());
        let typed = empty.into_typed(Term::new(Season::Fall, 2026));
        assert!(typed.courses.is_empty());
        assert_eq!(
            typed.message.as_deref(),
            Some("The search returns no results.")
        );
        // The criteria are echoed even when nothing came back — a bare empty list
        // is not a self-explanatory answer.
        assert_eq!(typed.subject, "CS");
        assert_eq!(typed.catalog_number, "246");
    }
}
