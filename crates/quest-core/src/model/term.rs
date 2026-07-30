//! UW term codes.
//!
//! Quest's grades page lists terms only by name ("Winter 2026") — the four-digit
//! code appears nowhere in its markup. But the code is a pure function of the
//! name, so both can be accepted and either reported:
//!
//! ```text
//! code = (year - 1900) * 10 + season   where Winter = 1, Spring = 5, Fall = 9
//!
//! Winter 2026 -> (2026-1900)*10 + 1 = 1261
//! Spring 2026 ->                      1265
//! Fall   2025 -> (2025-1900)*10 + 9 = 1259
//! ```

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Season {
    Winter,
    Spring,
    Fall,
}

impl Season {
    /// The last digit of a UW term code.
    fn digit(self) -> u16 {
        match self {
            Season::Winter => 1,
            Season::Spring => 5,
            Season::Fall => 9,
        }
    }

    fn from_digit(digit: u16) -> Option<Self> {
        match digit {
            1 => Some(Season::Winter),
            5 => Some(Season::Spring),
            9 => Some(Season::Fall),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Season::Winter => "Winter",
            Season::Spring => "Spring",
            Season::Fall => "Fall",
        }
    }
}

/// A specific academic term.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Term {
    pub code: u16,
    pub season: Season,
    pub year: u16,
}

impl Term {
    pub fn new(season: Season, year: u16) -> Self {
        Self {
            code: (year - 1900) * 10 + season.digit(),
            season,
            year,
        }
    }

    /// The label Quest shows, which is also how the worker matches the term row.
    pub fn label(&self) -> String {
        format!("{} {}", self.season.name(), self.year)
    }
}

impl fmt::Display for Term {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.label(), self.code)
    }
}

impl FromStr for Term {
    type Err = Error;

    /// Accepts a four-digit code (`1261`) or a name in any reasonable shape:
    /// `"Winter 2026"`, `"winter2026"`, `"w2026"`, `"2026 winter"`.
    fn from_str(input: &str) -> Result<Self, Self::Err> {
        let raw = input.trim();
        if raw.is_empty() {
            return Err(Error::Config("empty term".into()));
        }

        // Four-digit code.
        if raw.len() == 4 && raw.chars().all(|c| c.is_ascii_digit()) {
            let code: u16 = raw.parse().map_err(|_| bad_term(raw))?;
            let season = Season::from_digit(code % 10).ok_or_else(|| bad_term(raw))?;
            let year = 1900 + code / 10;
            return Ok(Self { code, season, year });
        }

        let lower = raw.to_ascii_lowercase();
        let season = if lower.contains("winter") || lower.starts_with('w') {
            Season::Winter
        } else if lower.contains("spring") || lower.starts_with('s') && !lower.starts_with("su") {
            Season::Spring
        } else if lower.contains("fall") || lower.starts_with('f') {
            Season::Fall
        } else {
            return Err(bad_term(raw));
        };

        let digits: String = lower.chars().filter(|c| c.is_ascii_digit()).collect();
        let year: u16 = digits.parse().map_err(|_| bad_term(raw))?;
        // Two-digit years are ambiguous forever; require four.
        if !(1900..=2200).contains(&year) {
            return Err(bad_term(raw));
        }
        Ok(Self::new(season, year))
    }
}

fn bad_term(raw: &str) -> Error {
    Error::Config(format!(
        "could not read `{raw}` as a term — use a code like `1261` or a name like \
         `\"Winter 2026\"`"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_uw_scheme() {
        assert_eq!(Term::new(Season::Winter, 2026).code, 1261);
        assert_eq!(Term::new(Season::Spring, 2026).code, 1265);
        assert_eq!(Term::new(Season::Fall, 2025).code, 1259);
        assert_eq!(Term::new(Season::Fall, 2026).code, 1269);
    }

    #[test]
    fn parses_codes() {
        let term: Term = "1261".parse().unwrap();
        assert_eq!(term.label(), "Winter 2026");
        assert_eq!(term.code, 1261);
        assert_eq!("1259".parse::<Term>().unwrap().label(), "Fall 2025");
        assert_eq!("1265".parse::<Term>().unwrap().label(), "Spring 2026");
    }

    #[test]
    fn parses_names_in_several_shapes() {
        for input in [
            "Winter 2026",
            "winter 2026",
            "winter2026",
            "w2026",
            "2026 winter",
        ] {
            let term: Term = input.parse().unwrap_or_else(|e| panic!("{input}: {e}"));
            assert_eq!(term.code, 1261, "for input {input}");
            assert_eq!(term.label(), "Winter 2026");
        }
        assert_eq!("f2025".parse::<Term>().unwrap().code, 1259);
        assert_eq!("spring2026".parse::<Term>().unwrap().code, 1265);
    }

    #[test]
    fn round_trips_code_to_label_and_back() {
        for code in [1219, 1231, 1235, 1239, 1259, 1261, 1265, 1269] {
            let term: Term = code.to_string().parse().unwrap();
            let again: Term = term.label().parse().unwrap();
            assert_eq!(term, again, "code {code} did not round trip");
        }
    }

    #[test]
    fn rejects_nonsense() {
        // A season digit UW does not use, and outright garbage.
        for input in ["1262", "", "next term", "Summer 2026", "20261"] {
            assert!(input.parse::<Term>().is_err(), "should reject {input:?}");
        }
    }
}
