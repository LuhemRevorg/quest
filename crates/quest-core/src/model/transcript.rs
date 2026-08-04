//! The downloaded unofficial transcript.
//!
//! Unlike grades and schedule this command's payload is a *file*, not a parsed
//! record. The worker hands the bytes over base64-encoded and this side decodes
//! and writes them, so the browser process never puts an academic record on the
//! filesystem and the 0600 discipline stays in one language. See ADR 0008.
//!
//! The transcript's contents are deliberately not parsed. A transcript revamp is
//! exactly what killed a prior community GPA tool, and a PDF that is saved
//! verbatim cannot come back subtly wrong.

use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptFormat {
    Pdf,
    /// PeopleSoft can render the report as a web page instead of a PDF.
    Html,
    /// Bytes we could not identify. Saved anyway, and reported as unknown rather
    /// than assumed to be a PDF.
    Unknown,
}

impl TranscriptFormat {
    /// File extension for the default output name.
    pub fn extension(self) -> &'static str {
        match self {
            TranscriptFormat::Pdf => "pdf",
            TranscriptFormat::Html => "html",
            TranscriptFormat::Unknown => "bin",
        }
    }
}

/// Which of the worker's three delivery channels produced the bytes. Reported
/// because `popup` is a refetch rather than the original response, and that is
/// worth being able to see when something looks off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSource {
    Download,
    Response,
    Popup,
}

/// What `quest transcript` emits. The bytes are on disk at `path`; they are not
/// in this payload, since a base64 PDF in a `--json` document helps nobody.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptDownload {
    pub schema_version: u32,
    /// The report type Quest was asked for, when the page offered a choice.
    pub report_type: Option<String>,
    pub institution: Option<String>,
    pub format: TranscriptFormat,
    pub content_type: Option<String>,
    pub source: CaptureSource,
    pub path: PathBuf,
    pub byte_length: usize,
    /// Hex SHA-256, computed by the worker over the bytes it captured. Re-running
    /// and getting the same digest means nothing changed upstream.
    pub sha256: String,
    pub retrieved_at: DateTime<Utc>,
}

/// What the worker sends back, before decoding. Field names mirror
/// `worker/src/handlers/transcript.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawTranscript {
    pub report_type: Option<String>,
    pub institution: Option<String>,
    pub format: TranscriptFormat,
    pub content_type: Option<String>,
    pub suggested_filename: Option<String>,
    pub source: CaptureSource,
    pub byte_length: usize,
    pub sha256: String,
    pub content_base64: String,
}

impl RawTranscript {
    /// Decode the report, checking it is the length the worker said it was.
    ///
    /// The length check is cheap and catches a truncated NDJSON line — the one
    /// plausible way these bytes get mangled in transit.
    pub fn decode(&self) -> Result<Vec<u8>> {
        let bytes = decode_base64(&self.content_base64).ok_or_else(|| Error::Parse {
            context: "transcript".into(),
            detail: "the worker sent a report that is not valid base64".into(),
        })?;

        if bytes.len() != self.byte_length {
            return Err(Error::Parse {
                context: "transcript".into(),
                detail: format!(
                    "report decoded to {} bytes but the worker reported {} — the response was \
                     truncated",
                    bytes.len(),
                    self.byte_length
                ),
            });
        }
        if bytes.is_empty() {
            return Err(Error::Parse {
                context: "transcript".into(),
                detail: "Quest returned an empty report".into(),
            });
        }
        Ok(bytes)
    }

    pub fn into_typed(self, path: PathBuf) -> TranscriptDownload {
        TranscriptDownload {
            schema_version: super::SCHEMA_VERSION,
            report_type: self.report_type,
            institution: self.institution,
            format: self.format,
            content_type: self.content_type,
            source: self.source,
            path,
            byte_length: self.byte_length,
            sha256: self.sha256,
            retrieved_at: Utc::now(),
        }
    }
}

/// `quest-unofficial-transcript-2026-07-30.pdf`.
///
/// Dated, so downloading again next term does not silently overwrite the last one,
/// and named "unofficial" so a file sitting in a downloads folder cannot be
/// mistaken for the real thing.
pub fn default_file_name(format: TranscriptFormat, when: NaiveDate) -> String {
    format!(
        "quest-unofficial-transcript-{}.{}",
        when.format("%Y-%m-%d"),
        format.extension()
    )
}

/// Standard-alphabet base64 with padding, tolerating whitespace.
///
/// Hand-rolled rather than pulling in a crate: this is a security-sensitive tool
/// where a dependency should earn its place, and the whole decoder is thirty lines
/// with tests. Returns `None` on anything malformed rather than salvaging a prefix.
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !cleaned.len().is_multiple_of(4) {
        return None;
    }

    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        // `=` is only ever trailing padding, and never more than two.
        if pad > 2 || chunk[..4 - pad].contains(&b'=') {
            return None;
        }

        let mut acc = 0u32;
        for &byte in &chunk[..4 - pad] {
            acc = (acc << 6) | value(byte)?;
        }
        acc <<= 6 * pad;

        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(content_base64: &str, byte_length: usize) -> RawTranscript {
        RawTranscript {
            report_type: Some("Unofficial Transcript".into()),
            institution: Some("University of Waterloo".into()),
            format: TranscriptFormat::Pdf,
            content_type: Some("application/pdf".into()),
            suggested_filename: Some("transcript.pdf".into()),
            source: CaptureSource::Download,
            byte_length,
            sha256: "0".repeat(64),
            content_base64: content_base64.into(),
        }
    }

    #[test]
    fn decodes_every_padding_case() {
        // The three chunk lengths, which is where a hand-rolled decoder goes wrong.
        for (encoded, expected) in [
            ("", &b""[..]),
            ("QQ==", b"A"),
            ("QUI=", b"AB"),
            ("QUJD", b"ABC"),
            ("QUJDRA==", b"ABCD"),
            ("SGVsbG8sIFF1ZXN0", b"Hello, Quest"),
        ] {
            assert_eq!(
                decode_base64(encoded).as_deref(),
                Some(expected),
                "{encoded}"
            );
        }
    }

    #[test]
    fn decodes_the_full_byte_range() {
        // Round-trip every byte value through a known-good encoding, so a bit-shift
        // error cannot hide in the high bits.
        let bytes: Vec<u8> = (0..=255u8).collect();
        let encoded = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v\
                       MDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5f\
                       YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6P\
                       kJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/\
                       wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v\
                       8PHy8/T19vf4+fr7/P3+/w==";
        assert_eq!(decode_base64(encoded), Some(bytes));
    }

    #[test]
    fn tolerates_whitespace_but_not_junk() {
        assert_eq!(decode_base64("QUJD\nRA==").as_deref(), Some(&b"ABCD"[..]));
        // Bad alphabet, bad length, and padding in the middle.
        for bad in ["QUJ!", "QUJDR", "QU=JD", "QQ===", "===="] {
            assert!(decode_base64(bad).is_none(), "should reject {bad:?}");
        }
    }

    /// A `%PDF` header survives decoding intact — the thing the CLI writes to disk.
    #[test]
    fn decodes_a_report_body() {
        let bytes = raw("JVBERi0xLjQK", 9).decode().unwrap();
        assert_eq!(&bytes, b"%PDF-1.4\n");
    }

    /// A truncated line is the one realistic transport failure, and it must not
    /// reach the filesystem as a half-written transcript.
    #[test]
    fn rejects_a_length_mismatch() {
        let err = raw("JVBERi0xLjQK", 9999).decode().unwrap_err();
        assert!(matches!(err, Error::Parse { .. }), "{err:?}");
        assert!(err.to_string().contains("truncated"), "{err}");
    }

    #[test]
    fn rejects_an_empty_or_malformed_report() {
        assert!(raw("", 0).decode().is_err());
        assert!(raw("not base64!!", 5).decode().is_err());
    }

    #[test]
    fn default_names_are_dated_and_say_unofficial() {
        let day = NaiveDate::from_ymd_opt(2026, 7, 30).unwrap();
        assert_eq!(
            default_file_name(TranscriptFormat::Pdf, day),
            "quest-unofficial-transcript-2026-07-30.pdf"
        );
        assert_eq!(
            default_file_name(TranscriptFormat::Html, day),
            "quest-unofficial-transcript-2026-07-30.html"
        );
        assert_eq!(
            default_file_name(TranscriptFormat::Unknown, day),
            "quest-unofficial-transcript-2026-07-30.bin"
        );
    }

    /// The worker's field names are a contract; a rename on either side must fail
    /// here rather than at runtime against a live account.
    #[test]
    fn deserializes_the_workers_payload() {
        let raw: RawTranscript = serde_json::from_str(
            r#"{
                "report_type": "Unofficial Transcript",
                "institution": "University of Waterloo",
                "format": "pdf",
                "content_type": "application/pdf",
                "suggested_filename": "transcript.pdf",
                "source": "response",
                "byte_length": 9,
                "sha256": "abc",
                "content_base64": "JVBERi0xLjQK"
            }"#,
        )
        .unwrap();

        assert_eq!(raw.format, TranscriptFormat::Pdf);
        assert_eq!(raw.source, CaptureSource::Response);
        assert_eq!(raw.decode().unwrap().len(), 9);

        let typed = raw.into_typed("/tmp/t.pdf".into());
        assert_eq!(typed.schema_version, super::super::SCHEMA_VERSION);
        assert_eq!(typed.path, PathBuf::from("/tmp/t.pdf"));
    }
}
