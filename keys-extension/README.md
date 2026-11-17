# Keys browser extension

Fills your logins on websites and offers to save new ones, for Chrome, Edge, Brave and other Chromium browsers (Chrome 120+). It talks to Keys (keys-web) running on this computer at 127.0.0.1:5174 and keeps no passwords itself.

Try it: open `chrome://extensions`, turn on **Developer mode**, **Load unpacked** and pick this folder. Keys must be updated together with the extension: since 1.2 every request is signed with the pairing key, which never leaves the extension, and Keys proves itself in each answer before the extension sends a password.
