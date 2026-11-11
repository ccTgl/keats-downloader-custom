# Privacy — KEATS Downloader Custom

The extension reads the Moodle course pages you select. Chrome uses your existing site session when the extension requests course resources. Requests go to the sites serving the course resources and, if selected, supported media providers. The extension has no telemetry service.

## Browser storage

- Chrome local extension storage holds settings and completed download history, including course and file names, resource identifiers, destination paths and completion times. Use **Downloaded Courses** to clear the extension's history.
- Chrome session extension storage holds the current preview and queue while Chrome is running. Temporary signed links are kept in worker memory. Chrome's download manager maintains its own download history.
- Your password is entered on the institution's sign-in page. Site cookies are managed by Chrome.

## Permissions

- **downloads** and **downloads.ui** allow the extension to use Chrome's download manager.
- **activeTab**, **scripting** and **tabs** allow the extension to read course pages and visit relevant resource pages.
- **storage** keeps settings, download history and current task state. **alarms** lets the extension check an active queue after the service worker has gone idle.
- HTTPS host access supports KEATS, other Moodle hosts and the optional media providers.
