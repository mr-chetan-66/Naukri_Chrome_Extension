# Naukri Auto Follow

## How to install in Chrome or Edge

1. Download or clone this project.
2. Open Chrome or Edge.
3. Go to:
   - Chrome: chrome://extensions
   - Edge: edge://extensions
4. Turn on Developer mode.
5. Click Load unpacked.
6. Select this project folder.
7. The extension is now installed.

## How to use it

1. Open Naukri and sign in.
2. Go to a filtered company list page.
3. Click the extension icon.
4. Set the batch size if needed.
5. Click Start.
6. The extension will open companies and click Follow automatically.
7. Use Pause/Continue if needed.
8. Use Reset if you want to clear progress.

## What it does

- Opens company links from the list
- Finds the Follow button automatically
- Moves to the next company
- Handles pagination
- Runs in batches
- Tracks processed and failed companies

## Recommended usage

- Use on a filtered company list you actually want to follow.
- Start with a small batch size first.
- Keep the tab open while it runs.

## Files

- manifest.json
- background.js
- popup.html
- popup.js
- icons/

## Disclaimer

Use this extension responsibly and in line with Naukri’s rules and platform limits.

## Recommended usage

- Use only on a filtered company list that you want to follow.
- Start with a smaller batch size to check reliability.
- Keep browser tab active while the process runs.
- Do not run extremely large batches if the page is slow.

## Example workflow

- Open Naukri company list with relevant filters
- Set a batch size such as 25
- Start the extension
- Let it work through the list automatically
- Review progress and continue when needed

## Files in this project

- manifest.json — extension configuration
- background.js — automation logic
- popup.html — popup UI
- popup.js — popup behavior
- icons — extension icons

## Disclaimer

This project is provided as a browser automation tool for convenience. The developer is not responsible for account restrictions, policy violations, or misuse of the extension. Use it carefully and responsibly.

## Support

If you are using this project locally, you can modify the script and adjust the batch size from the extension popup if needed.
