// Test only (see test/official.js). An instance that behaves as an official build ignores FS_HOME and
// refuses --user-data-dir, so Chromium's first writes at start-up go to the default profile directory,
// which is named after the app. Run as "FriendsShare" that would be the person's real profile. Under
// this wrapper the name is another one, and nothing of the real FriendsShare is touched.
require('../../app/main.js');
