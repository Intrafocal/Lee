import 'package:flutter/material.dart';

import '../models/hester_models.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Compact horizontal indicator showing the current ReAct phase.
///
/// Shows an animated dot + phase label (e.g., "Acting -- read_file").
/// Fades out when [phase] is null.
class ReActPhaseIndicator extends StatelessWidget {
  final PhaseEvent? phase;

  const ReActPhaseIndicator({required this.phase, super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedCrossFade(
      duration: const Duration(milliseconds: 200),
      crossFadeState:
          phase != null ? CrossFadeState.showFirst : CrossFadeState.showSecond,
      firstChild: _PhaseContent(phase: phase),
      secondChild: const SizedBox(height: 0),
    );
  }
}

class _PhaseContent extends StatefulWidget {
  final PhaseEvent? phase;

  const _PhaseContent({required this.phase});

  @override
  State<_PhaseContent> createState() => _PhaseContentState();
}

class _PhaseContentState extends State<_PhaseContent>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController;
  late final Animation<double> _pulseAnimation;

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    )..repeat(reverse: true);
    _pulseAnimation = Tween<double>(begin: 0.4, end: 1.0).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _pulseController.dispose();
    super.dispose();
  }

  Color _phaseColor(ReActPhase phase) {
    switch (phase) {
      case ReActPhase.preparing:
        return AeronautColors.textSecondary;
      case ReActPhase.thinking:
        return AeronautColors.info;
      case ReActPhase.acting:
        return AeronautColors.accent;
      case ReActPhase.observing:
        return AeronautColors.warning;
      case ReActPhase.responding:
        return AeronautColors.accent;
    }
  }

  @override
  Widget build(BuildContext context) {
    final phase = widget.phase;
    if (phase == null) return const SizedBox.shrink();

    final color = _phaseColor(phase.phase);
    final hasToolInfo = phase.toolName != null;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingMd,
        vertical: AeronautTheme.spacingSm,
      ),
      decoration: BoxDecoration(
        color: AeronautColors.bgSurface,
        border: const Border(
          bottom: BorderSide(color: AeronautColors.border),
        ),
      ),
      child: Row(
        children: [
          // Pulsing dot
          AnimatedBuilder(
            animation: _pulseAnimation,
            builder: (_, __) => Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: _pulseAnimation.value),
              ),
            ),
          ),
          const SizedBox(width: AeronautTheme.spacingSm),
          // Phase label
          Text(
            phase.phase.label,
            style: AeronautTheme.caption.copyWith(
              color: color,
              fontWeight: FontWeight.w600,
            ),
          ),
          // Tool info
          if (hasToolInfo) ...[
            Text(
              '  --  ',
              style: AeronautTheme.caption.copyWith(
                color: AeronautColors.textTertiary,
              ),
            ),
            Flexible(
              child: Text(
                phase.toolName!,
                style: AeronautTheme.mono.copyWith(
                  fontSize: 12,
                  color: AeronautColors.textSecondary,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (phase.toolContext != null) ...[
              const SizedBox(width: AeronautTheme.spacingXs),
              Flexible(
                child: Text(
                  '(${phase.toolContext})',
                  style: AeronautTheme.caption.copyWith(
                    color: AeronautColors.textTertiary,
                    fontStyle: FontStyle.italic,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
          const Spacer(),
          // Iteration badge
          if (phase.iteration > 0)
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 6,
                vertical: 2,
              ),
              decoration: BoxDecoration(
                color: AeronautColors.bgElevated,
                borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
              ),
              child: Text(
                '#${phase.iteration}',
                style: AeronautTheme.caption.copyWith(fontSize: 10),
              ),
            ),
        ],
      ),
    );
  }
}
