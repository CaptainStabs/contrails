# MyFlightbook Telemetry

Tools for turning MyFlightbook telemetry exports into a map of all your flights:

- **`Combine-Telemetry.ps1`** merges every `.csv` and `.kml` telemetry file into one KML for Google Earth, including a tour that replays the flights.
- **`flight-animation.html`** is a browser page that animates your flights on a map and can export the animation as a 1080p MP4.

The two are independent. The page reads the telemetry files itself, so you don't need to run the script first.

## Files

| Path | What it is |
|---|---|
| `Combine-Telemetry.ps1` | PowerShell script that writes `combined-flights.kml` |
| `combined-flights.kml` | Output of the script (all flights plus the Google Earth tour) |
| `flight-animation.html` | Animation page: layout and controls |
| `flight-animation.js` | Animation page: all of its logic (parsing, camera, drawing, video export) |
| `lib/` | Local copies of the libraries the page uses, so it works when opened from disk |
| `*.CSV`, `*.KML` | Telemetry files exported from MyFlightbook (one per flight) |

## Telemetry formats

Both tools read the per-flight files MyFlightbook exports:

- **CSV** with the header `LAT,LON,PALT,SPEED,HERROR,DATE,TZOFFSET,COMMENT`. `PALT` is taken as feet above sea level. `DATE` is a UTC timestamp.
- **KML** containing timestamped `gx:Track` paths (`<when>` and `<gx:coord>` elements). The KML script also accepts plain `LineString` paths, drawn without timestamps.

Points at exactly 0,0 (GPS dropouts) are ignored by the animation page.

## Combined KML for Google Earth

Run the script in the folder that holds your telemetry files:

```powershell
powershell -ExecutionPolicy Bypass -File .\Combine-Telemetry.ps1
```

It writes `combined-flights.kml` containing:

- **One track per flight:** sorted by start time, named by date (and tail number when the source KML has one), and colored differently from its neighbors.
- **Timestamps:** every point keeps its time, so Google Earth's time slider can replay the flights.
- **Altitude:** CSV tracks are drawn in 3D from their pressure altitude. KML tracks with all-zero altitudes are drawn on the ground.
- **A tour named "Flight history zoom-out":** for each flight, the camera zooms out to fit everything so far, then the flight is traced.

### Options

| Parameter | Default | Meaning |
|---|---|---|
| `-InputDir` | Script folder | Folder with the telemetry files |
| `-OutputFile` | `combined-flights.kml` next to the script | Where to write the KML |
| `-TourZoomSeconds` | `0.75` | Camera move per flight in the tour |
| `-TourTraceSeconds` | `1` | Time to trace each flight. `0` leaves the tour out |
| `-TourTraceSteps` | `10` | Keyframes per trace (more is smoother) |
| `-TourMinRangeMeters` | `8000` | Closest the tour camera gets |

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\Combine-Telemetry.ps1 -InputDir C:\telemetry -OutputFile C:\out\all-flights.kml -TourTraceSeconds 2
```

If a file is briefly locked (for example by antivirus or a sync tool), the script retries it and makes a second pass at the end. Any file it still can't read is listed in a warning.

### Playing the tour

Open the KML in **Google Earth Pro** (the desktop app) and double-click **"Flight history zoom-out"** in the Places panel. To save it as a video, use **Tools → Movie Maker** and pick the tour as the source. Google Earth in the browser doesn't play tours reliably.

## Animation page

Open `flight-animation.html` in **Chrome or Edge**, directly from disk. No web server is needed, but keep `flight-animation.js` and the `lib/` folder next to it.

Then load your flights in one of three ways:

- **Open folder…** and pick your telemetry folder.
- **Open files…** and select individual `.csv` or `.kml` files.
- Drag files onto the page.

You can load the raw MyFlightbook files, `combined-flights.kml`, or a mix. If the same flight appears twice, only one copy is kept.

### What it shows

There are two modes:

- **One at a time:** flights play in date order. For each one, the camera moves to fit it along with every earlier flight, then the new flight is drawn in orange with a moving dot at its front. Earlier flights stay on the map in blue. The date and "Flight N of total" appear in the lower left. After the last flight, the camera pulls back to show everything.
- **All at once:** every flight starts drawing at the same moment, each from its own takeoff, at its real relative speed. The longest flight takes the whole draw time and shorter ones finish earlier. A dot marks the front of each flight still drawing. The camera starts close and zooms out as the trails spread, so everything stays in frame. The lower left shows the date range and the number of flights.

### Controls

| Control | What it does |
|---|---|
| Play / Restart | Play or pause (also **Space**), or jump back to the start |
| Record | Export the animation as `flight-history.mp4` (see below) |
| Timeline | Jump to any point |
| Mode | **One at a time** or **All at once** (see above) |
| Zoom-out per flight | One at a time: how long each camera move takes |
| Trace per flight | One at a time: how long each flight takes to draw |
| Draw time | All at once: how long the longest flight takes to draw (5–60 s) |
| Small flights | One at a time: **Keep the overview** only ever zooms out. The **Zoom in** settings move in close on flights that would fill less than half (or a quarter) of the view, so small local flights aren't tiny |
| Basemap | Dark, Light, or Satellite |
| Video | 1920×1080 at 60 fps, or 30 fps to render faster |
| Hide / **H** | Hide the panel |

The page remembers these settings between visits, but you need to open your files again each time you load it.

The map always renders at 1920×1080, the video size, and is scaled to fit the window. If the window has a different shape, it shows black bars rather than cropping the map.

### Exporting a video

**Record** renders the animation frame by frame rather than capturing the screen live. Each frame waits for its map tiles to load before it is encoded, so the video comes out smooth and complete even on a slow machine. When it finishes, the browser downloads `flight-history.mp4`. **Cancel** stops it partway.

Expect a few minutes of rendering for the full animation, and a file of roughly 150–300 MB at 60 fps. This needs a browser with WebCodecs video encoding (current Chrome or Edge).

### Requirements and credits

- **Internet connection:** map tiles come from CARTO (dark and light) or Esri (satellite). The libraries are local, but the tiles aren't.
- **Credits:** the map credits are drawn in the bottom-right corner of exported videos. Keep them if you share the video.

Libraries in `lib/`:

| Library | Version | Source |
|---|---|---|
| MapLibre GL JS | 5.24.0 | https://unpkg.com/maplibre-gl@5.24.0/dist/ |
| deck.gl | 9.3.11 | https://unpkg.com/deck.gl@9.3.11/dist.min.js |
| mp4-muxer | 5.2.2 | https://unpkg.com/mp4-muxer@5.2.2/build/mp4-muxer.js |

To update one, download the new version over the matching file in `lib/` and update the version comment at the top of `flight-animation.html`.

### Changing the animation

All the logic is in `flight-animation.js`:

| To change | Look at |
|---|---|
| Colors, line widths, closest zoom, final hold | Constants near the top: `ACTIVE`, `DONE`, `MAX_ZOOM`, `END_HOLD`, `PADDING`, `FOCUS_CONTEXT`, and `TOGETHER_STEPS` (camera keyframes in All at once) |
| Basemaps | `BASEMAPS` |
| Reading telemetry files | `parseCsv`, `parseKml`, `makeFlight`, `loadFiles` |
| Timing | `buildTimeline`, `phaseAt` |
| Camera framing and moves | `computeTargets`, `computeTogetherCameras` (All at once), `flyCamera`, `cameraAt` |
| Drawing tracks and the moving dot | `render` |
| Date overlay and credits in the video | `drawRecordFrame` |
| MP4 export | The `record` button handler |

## Troubleshooting

- **The page stays blank or shows "Libraries failed to load":** make sure `flight-animation.js` and the `lib/` folder are in the same folder as the page. The file preview in some apps opens the page without its neighboring files. Open it in Chrome or Edge instead.
- **Tracks show but the map background is black:** the map tiles couldn't load. Check your internet connection. The status line shows the map error.
- **"No timestamped flight tracks found":** the selected files have no usable timestamps, or aren't MyFlightbook telemetry.
- **The script reports 0 tracks:** check that `-InputDir` points at the folder with the `.csv`/`.kml` files.
