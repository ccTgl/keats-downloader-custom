# Changelog

## [1.5.0]

### Added

- Scan attachments and resource links inside same-origin Moodle Pages, with limits on depth and page visits.
- Select weeks or sections and preview resources before confirming a download.
- Detect duplicates using course and resource identifiers, with compatibility for existing download history.
- Show progress using Chrome download states and restore the current preview or queue when the extension worker restarts within a browser session.

### Changed

- Record a download in local history after Chrome reports completion.
- Package the unpacked Chrome extension with the MIT license and installation instructions. The v1.5.0 source tree and installer ZIP omit the legacy executable archive.

### Verification

- 123 Jest tests passed. Local Chrome testing used synthetic Moodle fixtures for the preview, download and recovery workflows.
- The project owner verified file downloads and duplicate detection on live KEATS.
