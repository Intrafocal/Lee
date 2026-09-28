import 'phosphor_icons.generated.dart';

/// Stopgap: `mic`, `speaker` and `camera` join `design/icons.json` in the
/// renderer's package this round (docs/plans/2026-09-28-tether-review-voice.md
/// §5.3), and `design/build.mjs` regenerates `phosphor_icons.generated.dart`
/// with them. Until that lands here these carry the same 24px, 1.75-stroke
/// style; once `PhosphorIcons.mic` exists, switch the call sites over and
/// delete this file.
abstract final class PendingIcons {
  static const mic = PhosphorIconData('mic', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/></svg>');
  static const speaker = PhosphorIconData('speaker', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/></svg>');
  static const speakerOff = PhosphorIconData('speaker-off', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4zM17 10l4 4M21 10l-4 4"/></svg>');
  static const camera = PhosphorIconData('camera', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4zM15.5 13a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0"/></svg>');
}
