# Changelog

## 0.1.10

- Preserve bounded traceback and continuation context for selected warning,
  error, critical, and fatal records.
- Apply redaction and response caps to every retained continuation line.
- Use compact English lifecycle messages with ISO-8601 UTC timestamps.
- Provide the repository metadata required for App Store installation without
  assigning an upstream app maintainer.

## 0.1.9

- Point banner assets to the original upstream project for publication.
- Validate both supported container architectures in CI.

## 0.1.8

- Point the Home Assistant app-store installation instructions to the original
  upstream project instead of the temporary test fork.

## 0.1.7

- Add a dedicated wide banner for the Info and Documentation pages with the
  excess top and bottom spacing removed.

## 0.1.6

- Redesign the Documentation page with visual branding, concise tables,
  step-by-step setup, expected results, and troubleshooting guidance.

## 0.1.5

- Load the wide Info-page logo from an absolute repository URL so Home
  Assistant can render it reliably.

## 0.1.4

- Add a dedicated Home Assistant Info page.
- Add an app icon and wide logo.

## 0.1.3

- Make lifecycle logs human-readable with German local date and time.

## 0.1.2

- Add safe, structured lifecycle and request-result logging.

## 0.1.1

- Read Supervisor-managed options before dropping to the unprivileged `node`
  user.

## 0.1.0

- Initial bounded Home Assistant Core diagnostics companion.
