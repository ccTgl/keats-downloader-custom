# KEATS Downloader Custom Privacy Policy for Microsoft Edge

This policy applies to KEATS Downloader Custom v1.5.2 for Microsoft Edge. The extension is an independently maintained fork of [edar9498/keats-downloader](https://github.com/edar9498/keats-downloader). King's College London, Moodle, Microsoft and the upstream developer are unaffiliated with this fork.

## Course data and downloads

When you open the extension on a supported course, it reads the current course URL, title, sections, and relevant resource links. When you start a scan, the extension may load selected Moodle sections, Folders, Pages and attachments to find and preview downloadable files. After confirmation, it processes response headers and file contents as needed to validate, name and save the selected files. The extension uses Microsoft Edge download records to show progress, verify completion and recover pending download submissions.

## Local data and controls

- Local extension storage holds the download folder preference and completed download metadata for duplicate detection, including course and file names, resource identifiers, destination paths, download IDs and completion times. Use **Downloaded Courses** in the popup to view and clear this history for one course or all courses.
- Session storage holds the current preview, queue, status, errors, badge information and some attachment links. Temporary media URLs are kept in worker memory. Restarting Edge clears the session state. The popup stores your theme preference locally.
- Microsoft Edge manages its own downloads list and your downloaded files. For ordinary Moodle attachments, the extension gives Edge a data URL containing encoded file bytes. Edge may retain that encoded content as a source URL in its download history after restart. Edge can also retain source URLs for optional media, including signed links. Manage those records in Edge Downloads and remove saved files from your device separately.
- You can manage or revoke site access, disable the extension, or remove it in **Extensions** in Edge. Media scanning is optional and can be left unchecked on future scans.

## Requests, sign-in and optional media

Ordinary Moodle Page, Folder and file requests go over HTTPS to the selected course origin in the signed-in tab. Edge handles normal site sign-in and eligible cookies. The extension does not read passwords, login form values or cookie values. Navigation to course sections or optional media may follow the institution's normal sign-in or launch redirects.

If you select optional Kaltura or Echo360 scanning, the extension may visit the linked activity and read posted download links and recording metadata. A signed media link can authorise a temporary download. Edge may send the link to the media provider or its file host when saving the file. If you select Echo360, your institution's Moodle site may send your name or email directly to Echo360 during its external-tool launch, depending on its settings. The institution and provider handle those requests under their own policies.

## Permissions and contact

The extension uses activeTab and scripting for the course and resource pages, downloads to save and track transfers, storage for settings and job state, and alarms to resume checking an active queue. It requires host access to keats.kcl.ac.uk and can request the selected compatible Moodle hostname and Echo360 regional sites when needed.

The maintainer does not operate an extension backend, receive course files or download history, run analytics or advertising, or sell user data. The project source and documentation are available on [GitHub](https://github.com/ccTgl/keats-downloader-custom).
