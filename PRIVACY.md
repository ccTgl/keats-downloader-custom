# KEATS Downloader Custom Privacy Policy

This policy covers the GitHub release v1.5.0 and the v1.5.1 build prepared for the Chrome Web Store.

KEATS Downloader Custom helps you select, preview and save files from KEATS or a compatible Moodle course. It is an independently maintained fork of [edar9498/keats-downloader](https://github.com/edar9498/keats-downloader) and has no affiliation with or endorsement from King's College London, Moodle or the upstream developer.

## Course and download data

When you open the popup on a course or start a scan, the extension reads course titles, URLs and identifiers, section names, activity and file names, and resource links. Scanning may load selected Moodle sections, folders, nested pages and optional media activities. The extension processes response headers and file contents as needed to find attachments, validate file types, name files and save the downloads you confirm.

- **v1.5.0** also checks tab URLs as pages finish loading. On a supported Moodle course page it can read the course title and resource links in the background to update the new-files badge. It keeps recent course tab URLs and check times in worker memory to avoid repeated checks.
- **v1.5.1** checks for new resources when you open the popup on a course. A tab navigation event clears the badge.

The extension uses Chrome download records to show progress and verify completion. When recovering an interrupted submission, it can check recent Chrome download records and match them locally to a download it started.

## Storage and retention

- Chrome local extension storage holds the download folder preference and completed download history for duplicate detection. History can include course and file names, course identifiers, resource identifiers or normalised URLs, download IDs, destination paths and completion times. Older history entries can contain original resource URLs. Use **Downloaded Courses** in the popup to clear history for one course or all courses.
- Chrome session extension storage holds the preview, queue, errors, progress and new-files badge information during the browser session. Some attachment URLs can be retained there for recovery. The extension keeps URLs it recognises as signed or sensitive in worker memory. v1.5.1 also keeps optional media download URLs in worker memory. Restarting Chrome clears the session state.
- The popup stores the theme preference in local browser storage. Chrome separately maintains its download list and saved files. Clearing the extension's history leaves those records and files in place. You can manage them in Chrome and on your device.

## Network requests and sign-in

Course requests go to Moodle and the servers that supply the requested resources. The extension can open temporary tabs for course activities. Chrome handles site sign-in and sends eligible cookies. The extension does not read passwords, sign-in form values or cookie values.

- **v1.5.0** reads nested Moodle pages and their attachments through the signed-in course tab. It fetches ordinary files and folder attachments from its background worker and can follow redirects to the resource's file server.
- **v1.5.1** fetches Moodle pages, folder listings and course files over HTTPS from the signed-in course tab. These requests stay on the selected course site's origin. Browser navigation to course sections and optional media activities can still follow the site's ordinary sign-in and launch redirects.

If you enable optional video or lecture capture scanning, the extension can open Kaltura or Echo360 activities and read recording names, dates, availability, identifiers and download links as applicable. Opening a Moodle external-tool activity can share account details such as your name or email with the provider under your institution's configuration. Optional media downloads may send signed links to the media provider or its file host. Chrome can retain the source URL in its own download list. The institution and the providers handle these requests under their own privacy policies.

- **v1.5.0** can read Kaltura session values from the player and use them with recording identifiers in Kaltura requests to find or validate a downloadable file. When looking for Echo360, it can open other Moodle external-tool activities if no clearly labelled link is found. It can also use playback information to locate an Echo360 media file.
- **v1.5.1** uses posted media download links and limits Echo360 discovery to identified lecture-capture activities and supported Echo360 sites. It does not extract Kaltura session values.

## Chrome permissions

- **activeTab** and **scripting** let the extension read course and resource pages for the workflow you start. **downloads** lets it save files, track progress and cancel its downloads. **storage** keeps settings, history and job state. **alarms** lets the service worker resume checking an active download queue.
- **v1.5.0** declares access to all HTTPS sites and the **tabs** permission for tab URL access, including its background course check. It also declares **downloads.ui**, which this release does not use.
- **v1.5.1** requires host access to **keats.kcl.ac.uk**. When you choose **Scan and Preview**, it requests access to the current compatible Moodle hostname if needed. It requests access to **echo360.org.uk**, **echo360.org**, **echo360.ca** and **echo360.net.au** when you enable Echo360 scanning. You can review site access in Chrome's extension settings.

## Sharing and Limited Use

The extension processes course and download data in Chrome for the file-saving workflow described above. The maintainer runs no extension backend, analytics, advertising or tracking service, receives no course or download history, and does not sell user data. The extension's use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Contact

Use the Chrome Web Store item's Support tab when the listing is available. The source and project documentation are available on [KEATS Downloader Custom on GitHub](https://github.com/ccTgl/keats-downloader-custom).
