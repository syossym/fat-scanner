# Fat100

A simple, privacy-first mobile web app that extracts fat content (**grams per 100g**) from photos of nutritional values labels right on your iPhone.

## Features
- **One-tap iPhone camera capture** (or choose from Photo Library)
- **100% on-device OCR** powered by [Tesseract.js](https://github.com/naptha/tesseract.js) — photos never leave your device
- **Automatic per-100g & per-serving support**:
  - Reads `per 100g` / `per 100ml` columns directly (EU, UK, international & multi-language Latin labels)
  - Automatically converts US/Canada `Serving size (Xg)` + `Total Fat Yg` labels into `g / 100g`
  - Ignores Saturated Fat, Trans Fat, `% Daily Value`, and `Calories from Fat`
- **Touch-friendly crop & 90° rotate** to isolate cluttered or sideways nutrition tables
- **Quick inline editor & serving converter** for instant manual tweaks
- **Installable on iPhone Home Screen** (Share → *Add to Home Screen*)

## Run Locally
Serve the static directory with any HTTP server:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000`.
