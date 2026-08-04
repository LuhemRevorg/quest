//! Command surface. Phase 1 exposes `auth` only — data commands are added in
//! later phases and are intentionally absent rather than stubbed.

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "quest",
    about = "Read and manage your own UW Quest academic record",
    version
)]
pub struct Cli {
    /// Emit machine-readable JSON on stdout. Human text and progress go to
    /// stderr, so stdout stays a clean single JSON document.
    #[arg(long, global = true)]
    pub json: bool,

    // A global `--interactive` belongs here per the design, but it would be inert
    // today and `--help` should not advertise a flag that does nothing: `login`
    // is interactive by definition, and `status`/`logout` never prompt. It lands
    // in Phase 2 with the first data command that can actually be gated by it.
    // Until then, prompting is gated on stdin being a terminal.
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Manage the persisted Quest session.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },

    /// Show grades for one term. Fully non-interactive.
    Grades(GradesArgs),

    /// Show the classes you are enrolled in for one term. Fully non-interactive.
    ///
    /// Quest only offers the current and upcoming term here, since enrolment is
    /// not kept historically — use `grades` for terms that are over.
    Schedule(ScheduleArgs),

    /// Search a term's class schedule for one course's sections. Fully
    /// non-interactive.
    ///
    /// This reads the catalog, not your record: it works for a course you are not
    /// enrolled in, and shows every section with its times, room, instructor and
    /// open/closed status.
    Search(SearchArgs),

    /// Download your unofficial transcript. Fully non-interactive.
    ///
    /// Saves the report Quest generates — normally a PDF — and prints where it
    /// went. It covers your whole record, so there is no term to pick.
    ///
    /// Only the *unofficial* transcript. Ordering an official one is a paid ($20)
    /// request, and this tool has no flag that places one.
    Transcript(TranscriptArgs),
}

#[derive(Debug, Args)]
pub struct TranscriptArgs {
    /// Where to save it. A directory gets a dated default name; a filename is used
    /// as given.
    ///
    /// Omitted, the report goes to your Downloads folder — where the browser this
    /// replaces would have put it. `QUEST_DOWNLOAD_DIR` overrides that.
    #[arg(long, short, value_name = "PATH")]
    pub output: Option<std::path::PathBuf>,

    /// Overwrite the file if it already exists.
    #[arg(long)]
    pub force: bool,

    /// Which report to request, when Quest offers more than one — e.g.
    /// `undergrad`. Matched exactly, then on word boundaries, then as a substring.
    ///
    /// UW offers `Undergrad Unofficial` and `Graduate Unofficial`; note
    /// "Undergrad", not "Undergraduate". Only needed if there is a choice; a sole
    /// report type is taken automatically, and an ambiguous one is an error
    /// listing the options rather than a guess.
    #[arg(long, value_name = "TEXT")]
    pub report_type: Option<String>,

    /// Seconds to allow for sign-in before giving up.
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,

    /// Seconds to wait for Quest to generate the report after the page is loaded.
    /// Separate from `--timeout`: PeopleSoft builds the PDF on demand and that has
    /// nothing to do with signing in.
    #[arg(long, default_value_t = 120)]
    pub report_timeout: u64,

    /// How to render the browser. `headed` is for watching it work.
    #[arg(long, value_enum, default_value_t = DisplayArg::Headless)]
    pub display: DisplayArg,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// Term, as a code or a name: `1269`, `"Fall 2026"`, `fall2026`, `f2026`.
    #[arg(long, value_name = "TERM")]
    pub term: String,

    /// Subject code, e.g. `CS`. Case-insensitive.
    #[arg(long, value_name = "SUBJECT")]
    pub subject: String,

    /// Catalog number, e.g. `246`. Matched exactly.
    ///
    /// Required, not optional: Quest's search demands at least two criteria beyond
    /// the term, so a subject on its own is rejected by the page itself.
    #[arg(long, value_name = "NUMBER")]
    pub number: String,

    /// Seconds to allow for sign-in before giving up.
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,

    /// How to render the browser. `headed` is for watching it work.
    #[arg(long, value_enum, default_value_t = DisplayArg::Headless)]
    pub display: DisplayArg,
}

#[derive(Debug, Args)]
pub struct ScheduleArgs {
    /// Term, as a code or a name: `1265`, `"Spring 2026"`, `spring2026`, `s2026`.
    #[arg(long, value_name = "TERM")]
    pub term: String,

    /// Seconds to allow for sign-in before giving up.
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,

    /// How to render the browser. `headed` is for watching it work.
    #[arg(long, value_enum, default_value_t = DisplayArg::Headless)]
    pub display: DisplayArg,
}

#[derive(Debug, Args)]
pub struct GradesArgs {
    /// Term, as a code or a name: `1261`, `"Winter 2026"`, `winter2026`, `w2026`.
    #[arg(long, value_name = "TERM")]
    pub term: String,

    /// Seconds to allow for sign-in before giving up.
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,

    /// How to render the browser. `headed` is for watching it work.
    #[arg(long, value_enum, default_value_t = DisplayArg::Headless)]
    pub display: DisplayArg,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Establish a session. Opens a real browser and waits for you to complete
    /// Duo. Interactive by nature — the only command that ever blocks on a
    /// human.
    Login(LoginArgs),

    /// Report whether the persisted session is live and when Duo device trust
    /// expires. Fully non-interactive.
    Status,

    /// Establish a live session without a human, using the keychain password and
    /// Duo device trust. Exits 77 (NEEDS_REAUTH) the moment a human would be
    /// needed, never prompts, never hangs.
    ///
    /// This is what Phase 2's data commands will call internally. UW disables
    /// ADFS keep-me-signed-in, so a password is required on every re-auth and
    /// there is no way to avoid this step.
    Refresh(RefreshArgs),

    /// Clear the persisted session.
    Logout(LogoutArgs),
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// WatIAM username, as the full address UW's ADFS expects — e.g.
    /// `jdoe@uwaterloo.ca`, not the bare 8-character userid. Defaults to the value
    /// saved in config.
    #[arg(long, value_name = "USER@uwaterloo.ca")]
    pub username: Option<String>,

    /// Save the password to the OS keychain for future logins. Off by default.
    #[arg(long)]
    pub save_password: bool,

    /// Seconds to wait for you to finish Duo before giving up.
    #[arg(long, default_value_t = 300)]
    pub duo_timeout: u64,
}

/// CLI mirror of [`quest_core::session::protocol::Display`]. Kept here so clap
/// stays out of the core crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum DisplayArg {
    /// No window at all. The default, and the only mode in which "unattended"
    /// means anything: with no window, nobody can click anything by hand.
    Headless,
    /// Visible window, for watching the sign-in chain when debugging.
    Headed,
}

impl From<DisplayArg> for quest_core::session::protocol::Display {
    fn from(value: DisplayArg) -> Self {
        use quest_core::session::protocol::Display;
        match value {
            DisplayArg::Headed => Display::Headed,
            DisplayArg::Headless => Display::Headless,
        }
    }
}

#[derive(Debug, Args)]
pub struct RefreshArgs {
    /// Seconds to allow for the silent sign-in before giving up. Short by design:
    /// with device trust valid this takes a couple of seconds, and anything longer
    /// means a human is needed.
    #[arg(long, default_value_t = 60)]
    pub timeout: u64,

    /// How to render the browser. `headless` is the default and the only mode where
    /// success proves the flow needs no human. Use `headed` to watch it happen.
    #[arg(long, value_enum, default_value_t = DisplayArg::Headless)]
    pub display: DisplayArg,
}

#[derive(Debug, Args)]
pub struct LogoutArgs {
    /// Also delete the stored password from the OS keychain.
    #[arg(long)]
    pub forget_password: bool,
}
