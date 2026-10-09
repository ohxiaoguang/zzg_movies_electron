# Local Film Library

[简体中文](README.md) | **English**

Organize your local videos, mark highlights worth revisiting, and bring favorite moments from different videos together with Resonance Ball.

Local Film Library is a Windows application for managing and playing a personal video collection. It reads existing videos, NFO metadata, posters, stills, and comment screenshots, with categories, favorites, search, playback, and organization-data backups. Everyday use centers on local files; LAN access and GitHub backups are optional.

[Download releases](https://github.com/ohxiaoguang/zzg_movies_electron/releases) · [Report an issue](https://github.com/ohxiaoguang/zzg_movies_electron/issues) · [GPL v3 license](LICENSE)

## Getting started

1. Download the Windows installer or ZIP from Releases, then install or extract and launch it.
2. Create an account and password on first launch. Sign in on subsequent launches; you can remember the account name.
3. Add a video folder in Source Management, choose whether to scan subfolders, and scan it.
4. Browse All Films and add custom categories or favorites.
5. Open a film and press `I` / `O` while watching to mark a highlight. To keep a moment alongside other videos, click “添加进共鸣球” (Add to Resonance Ball).

Chinese labels below help identify controls in the current interface.

## Featured: video highlights

Highlights record a start time, end time, and title for a memorable section. Annotations stay in your library without trimming or modifying the video or rewriting its NFO file.

### Mark moments while watching

- In the annotation tab, press `I` at the start and `O` at the end, or use the corresponding buttons.
- Enter a title, such as “Chase scene,” choose whether to include it in previews, and add the segment. Each annotation belongs to a specific video file, including individual parts of a multipart film.
- The list shows titles, durations, and preview switches. Delete unwanted annotations or change whether each segment participates in previews.
- Marking a VR video also captures the current view; playing the segment can restore that view.
- When a source video changes, its annotations prompt you to check whether the saved times still match.

### Revisit highlights on the timeline

- The detail timeline shows annotated ranges in the current file. Hover to see their titles and times.
- Clicking the timeline seeks to the clicked position; clicking a segment in the list starts at its beginning.
- Detail playback continues through the original video after the annotated end time.
- Space toggles play/pause. Left and right arrows seek; hold `Shift` for finer adjustments. Both intervals are configurable.

### Preview highlights from film cards

- Hover over a card to open a landscape popup that plays selected highlight ranges in sequence and loops them.
- Video previews are muted by default, helping you recall a film while browsing.
- Switch between Highlights, Comments, and Stills; images appear as slideshows.
- With no usable highlights, the popup prefers comment screenshots, then stills. Unplayable videos also fall back to images.
- Adjust opening and closing delays and the slideshow interval in Settings.

## Featured: Resonance Ball

Resonance Ball brings different videos into one viewing surface so you can revisit favorite moments together. Each video keeps an independent position, and the combination can be saved as a scene.

### Collect and play videos together

1. Open a film, choose its video file, and seek to a moment to keep.
2. Click “添加进共鸣球” (Add to Resonance Ball). The position becomes its highlight moment, and detail playback pauses. VR videos also bring their current view.
3. Add videos from other films, then click the ball at the lower left to open the multi-video view. Its badge shows the video count.

- Videos arrange themselves according to their aspect ratios and retain independent positions.
- Play/pause all together, or control each video's playback and seek position separately.
- Adding the same video again in the current scene updates its position and highlight moment.
- **Return to highlight moments (“回到精彩时刻”):** seek every video to its saved moment while preserving its playing or paused state.
- **Update all highlight moments (“更新全部精彩时刻”):** replace the current scene's saved moments with each video's current position.
- Remove videos individually, or click Clear twice to confirm clearing only the active scene. Closing the ball pauses playback and retains positions.

**Segments and moments serve different purposes:** a highlight segment is a time range for annotations, navigation, and hover previews. A Resonance Ball highlight moment is one timestamp for a video in a particular scene, used to return the group to its chosen positions.

### Keep multiple scenes

| Action | Result |
| --- | --- |
| Temporary scene | Retains an unnamed combination while you collect videos. |
| New scene | Creates and switches to a named empty scene, keeping the previous scene and its positions. Add videos from film details afterward. |
| Save as scene / Save as new scene | Saves the current combination under a new name and switches to it. |
| Switch scenes | Saves and pauses the current combination, restores the selected scene's positions, and waits for playback. |
| Manage scenes | Rename, copy, or delete. Copies are independent; deleting the active scene returns to the temporary scene. |
| Automatic saving | Each scene keeps its video list and order, positions, highlight moments, aspect ratios, and VR views. The last selected scene returns after restarting. |

Changes save to the active scene. Create a new scene or save a copy before trying another combination you want to keep separately. Removing videos, clearing, or deleting scenes does not delete media files. Resonance Ball is currently available in the desktop client.

## Browsing and organization

- **Cards and tables:** switch between a poster grid and a list, and adjust card width and page size. Missing posters can be generated from videos when available.
- **Library views:** All Films, Unorganized, Organized, Favorites, and All Data. Unorganized films have no custom categories; organized films have at least one.
- **My Categories:** create, rename, reorder, and delete categories. A film can have several. Deleting a category leaves media, favorites, and NFO tags intact.
- **Favorites and editing:** favorites and category changes save automatically. Edit titles, original titles, ratings, and notes in details.
- **Global filters:** multiple sources match any selected source; multiple categories require all selected categories. Filters persist across film pages and after restarting or refreshing, with a clear-all action.
- **Page filters and sorting:** search, filter by NFO tags or actors, and sort by title, year, rating, filename, size, recently added, recently watched, and more. Page-specific filters reset when changing film pages.
- **Actors:** browse actors and film counts from existing metadata, then open their related films.
- **CSV export:** export filtered results from Organized and Favorites, including filenames, NFO titles, categories, actors, NFO summaries, and highlight segments. Exports include all matching results across pages.
- **Index cleanup:** All Data shows missing files, offline sources, same-name films, and other records. Delete unwanted library entries in bulk and rescan to import again.

## Sources and local metadata

### Importing and scanning

- Add multiple sources with independent names, enabled states, and rescan actions. Details can also rescan just the film's containing folder.
- Configure recursive scanning, ignored folders, video/image extensions, and optional scanning on startup.
- Default video extensions include MP4, MKV, MOV, AVI, WEBM, M4V, MPG, MPEG, TS, FLV, and WMV. Playback also depends on the video's encoding.
- Files named `Name-cd1.ext`, `Name-cd2.ext`, and so on in the same folder form a multipart film. Matching names with different extensions remain separate films.
- Offline sources, failed scans, and canceled scans retain existing records. Successful scans mark indexed films that can no longer be found as missing.
- Renaming or moving a file may leave a missing entry at its old location and import a new entry at its new location. Clean up obsolete entries in All Data.

### NFO files, posters, stills, and comment screenshots

- Read existing NFO titles, years, release dates, runtimes, summaries, actors, directors, ratings, countries, studios, and tags.
- NFO tags are read-only for display and filtering. Use My Categories for your own organization.
- Fill empty fields from NFO data, or choose merge/replace when reimporting. In-app edits stay in the library without writing back to NFO files.
- Recognize matching posters such as `MovieA-poster.jpg`. Single-film folders can also use `poster.jpg`, `folder.jpg`, `cover.jpg`, `fanart.jpg`, and other common resource names.
- In folders with several films, `MovieA.jpg` / `MovieA.jpeg` can serve as the matching video's poster; a matching `-poster` image takes priority.
- Images in `extrafanart/` are stills. Images in a sibling `comment/` folder are comment screenshots, browsed in natural order.
- Click a thumbnail in the image tab to open a large viewer, then use buttons or arrow keys to navigate.

### Moving and removing sources

- Transfer physically moves scanned videos and associated resources into a separate subfolder in the destination source, preserving favorites, categories, and highlights.
- After an interrupted transfer, the next launch attempts recovery. Reconnect affected disks and resolve reported file conflicts before continuing.
- Disabling retains films; archiving retains archived records. Removing source records or film index entries does not delete external videos, images, or NFO files.

## Playback and preferences

- **Detail workspace:** metadata and categories on the left; original playback, annotations, and images on the right. Videos fit without cropping.
- **Playback options:** use the built-in player, with a compatibility version attempted when needed, or open a local player or the video's folder.
- **Subtitles:** desktop and web details let you choose available subtitle tracks or turn them off. Font size is adjustable.
- **360° VR:** supports monoscopic 360° videos with a per-file VR setting. Drag to look around, scroll to zoom, and reset the view. Resonance Ball also displays VR videos.
- **Compact viewing mode (“摸鱼模式”):** shrink video and cover images within the same outer frame. Videos sit at the bottom right, images stay centered, and subtitles remain at the bottom of the full player area. The scale is adjustable.
- **Startup and tray:** the installed Windows version supports launching on sign-in, starting in the tray, and minimizing to the tray. Closing the window exits.
- **Cache controls:** inspect usage, change the cache directory and limit, open its folder, or clear it without deleting original videos.
- **Optional media tools:** configure and test ffprobe in Settings; with ffmpeg, it enables additional media information, generated covers, and compatible playback. Video import and reading existing metadata remain available without these tools.

## LAN web access

Enable the web service in Settings, choose local-only or private LAN access, and configure the port and network address. Phones, tablets, and other computers can use the displayed URL to browse/filter the library, view details, play videos, select subtitles, and jump to highlights.

LAN mode uses the desktop account and password, and the host application must remain running. View existing annotations on the web; create new ones in the desktop client. Resonance Ball is not yet available on the web. The service is intended for trusted private networks.

## GitHub private-repository backups

Back up organization data to a dedicated private GitHub repository and restore it after reinstalling or moving to another computer.

- **Included:** favorites, custom category assignments, highlights, and Resonance Ball scenes, including the temporary scene, video order, positions, highlight moments, aspect ratios, VR views, and file information needed for restoration matching.
- **Media stays local:** excludes original videos, source paths, drive letters, posters, account credentials, and the full local database.
- **Backup options:** manual backups and automatic backups on startup/exit. Unchanged data avoids duplicate uploads; failures can retry on the next launch.
- **History:** select a version and preview matched, missing, ambiguous, and recoverable-segment counts before restoring.
- **Across computers:** match by filename, size, and available duration without requiring identical drives or folders. Ambiguous matches are skipped.
- **Restore scope:** replace favorites, categories, and highlights for matched films. Backups with scenes replace all local named and temporary scenes; unmatched scene videos are skipped, while names and empty scenes remain.
- **Protection:** a local safety copy is saved before restoring. Empty libraries and sharp reductions in film count can block automatic overwrites of valid backups.

Setup requires a dedicated private repository and a token with Contents read/write permission for that repository. Older backups without scenes remain supported and leave local scenes unchanged when restored.

## FAQ

**Can I use it without NFO files?**

Yes. Import videos, edit details, organize categories and favorites, and mark highlights yourself. Online metadata scraping is currently unavailable.

**Will I lose my organization when an external disk is disconnected?**

Existing records remain while a source is offline. Reconnect and rescan to check its status.

**Why does a card show images instead of video?**

Add highlights and enable their preview switches first. Cards without highlights show images; inaccessible or unplayable videos also fall back to images.

**Do highlights create separate clips?**

No. Annotations locate and preview sections of the original video. Clip trimming/export is currently unavailable.

**Can I play immediately after restoring on a new computer?**

Backups contain organization data. Make videos accessible on the new computer and scan them before restoring.

**What are the current limitations?**

The app targets Windows. Online metadata scraping, NFO write-back, nested categories, TV season/episode management, and automatic updates are currently unavailable.

## License

Copyright (c) 2026 Local Film Library contributors.

This project is licensed under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only). Use, modification, and commercial distribution are permitted. Distribution of this project or modified versions must comply with GPL v3, retain the required notices, and provide corresponding source code as required by the license. Derivative works must also follow GPL v3. This software comes without any warranty. Third-party components and users' videos, images, and other content retain their respective licenses or ownership.
