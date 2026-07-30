//! Grades for one term.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::term::Term;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermGrades {
    pub schema_version: u32,
    pub term: Term,
    /// Quest's own label for the term it rendered, kept so a consumer can see the
    /// page agreed with the request rather than trusting us.
    pub term_shown: Option<String>,
    pub academic_standing: Option<String>,
    pub courses: Vec<CourseGrade>,
    pub retrieved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseGrade {
    /// e.g. `"MATH 137"`.
    pub class: Option<String>,
    pub description: Option<String>,
    pub units: Option<f64>,
    /// e.g. `"NUM"` for numeric, `"CNS"` for credit/no-credit.
    pub grading_basis: Option<String>,
    /// Left as text on purpose: grades are not all numbers. `"A+"`, `"CR"`, `"IP"`
    /// (in progress) and `""` (not yet released) are all real values.
    pub grade: Option<String>,
    pub grade_points: Option<f64>,
}

/// What the worker sends back, before typing. Field names mirror
/// `worker/src/handlers/grades.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawTermGrades {
    pub term_requested: String,
    pub term_shown: Option<String>,
    pub academic_standing: Option<String>,
    pub courses: Vec<RawCourseGrade>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawCourseGrade {
    pub class_name: Option<String>,
    pub description: Option<String>,
    pub units: Option<String>,
    pub grading_basis: Option<String>,
    pub grade: Option<String>,
    pub grade_points: Option<String>,
}

impl RawTermGrades {
    /// Type the scraped strings. Numbers that fail to parse become `None` rather
    /// than an error: Quest legitimately leaves units blank on some rows, and a
    /// single odd cell should not cost you the whole term.
    pub fn into_typed(self, term: Term) -> TermGrades {
        TermGrades {
            schema_version: super::SCHEMA_VERSION,
            term,
            term_shown: self.term_shown,
            academic_standing: self.academic_standing,
            courses: self
                .courses
                .into_iter()
                .map(|raw| CourseGrade {
                    class: raw.class_name,
                    description: raw.description,
                    units: parse_number(raw.units.as_deref()),
                    grading_basis: raw.grading_basis,
                    grade: raw.grade,
                    grade_points: parse_number(raw.grade_points.as_deref()),
                })
                .collect(),
            retrieved_at: Utc::now(),
        }
    }
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    value?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::term::Season;

    fn raw(units: Option<&str>, points: Option<&str>) -> RawTermGrades {
        RawTermGrades {
            term_requested: "Winter 2026".into(),
            term_shown: Some("Winter 2026".into()),
            academic_standing: None,
            courses: vec![RawCourseGrade {
                class_name: Some("ABCD 100".into()),
                description: Some("Placeholder Course".into()),
                units: units.map(str::to_owned),
                grading_basis: Some("NUM".into()),
                grade: Some("A+".into()),
                grade_points: points.map(str::to_owned),
            }],
        }
    }

    #[test]
    fn types_numeric_cells() {
        let typed = raw(Some("0.50"), Some("2.000")).into_typed(Term::new(Season::Winter, 2026));
        assert_eq!(typed.courses[0].units, Some(0.5));
        assert_eq!(typed.courses[0].grade_points, Some(2.0));
        assert_eq!(typed.term.code, 1261);
    }

    /// A blank or non-numeric cell must not fail the whole term.
    #[test]
    fn tolerates_unparseable_numbers() {
        let typed = raw(None, Some("")).into_typed(Term::new(Season::Winter, 2026));
        assert_eq!(typed.courses[0].units, None);
        assert_eq!(typed.courses[0].grade_points, None);
        // The rest of the row survives.
        assert_eq!(typed.courses[0].grade.as_deref(), Some("A+"));
    }

    /// Grades are not always numbers, so the field stays a string.
    #[test]
    fn keeps_non_numeric_grades_verbatim() {
        for grade in ["A+", "CR", "IP", "NCR"] {
            let mut r = raw(Some("0.50"), None);
            r.courses[0].grade = Some(grade.into());
            let typed = r.into_typed(Term::new(Season::Fall, 2025));
            assert_eq!(typed.courses[0].grade.as_deref(), Some(grade));
        }
    }
}
