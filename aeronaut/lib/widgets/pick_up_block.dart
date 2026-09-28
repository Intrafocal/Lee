import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/tether.dart';
import '../providers/tether_provider.dart';
import '../screens/review_screen.dart' show ReviewSection, ago, reviewSectionProvider;
import '../screens/root_shell.dart' show RootTab, rootTabProvider;
import '../theme/aeronaut_theme.dart';
import 'work_ui.dart';

/// Opens the Page [cardId] in Review, on Review's own stack.
void openPageInReview(WidgetRef ref, String cardId, String title) {
  ref.read(reviewSectionProvider.notifier).state = ReviewSection.desk;
  ref.read(reviewPageRequestProvider.notifier).state = PageRequest(cardId, title);
  ref.read(rootTabProvider.notifier).state = RootTab.review;
}

/// Work's first block (docs/plans/2026-09-28-tether-review-voice.md §3.1),
/// from Lee's `GET /tether`: your last card's title and Area, where you
/// stopped (your words, in the writing font) and up to five open
/// questions. A tap opens the Page in Review. Quiet when there's nothing
/// to pick up or Hester is away: Work is about what needs you.
class PickUpBlock extends ConsumerWidget {
  const PickUpBlock({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tether = ref.watch(tetherProvider).valueOrNull?.tether;
    final pickUp = tether?.pickUp;
    if (tether == null || (pickUp == null && tether.openQuestions.isEmpty)) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('Pick up'),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
          child: WorkCard(
            key: const ValueKey('pick-up'),
            onOpen: pickUp == null ? null : () => openPageInReview(ref, pickUp.cardId, pickUp.title),
            child: _PickUpBody(tether: tether),
          ),
        ),
      ],
    );
  }
}

class _PickUpBody extends StatelessWidget {
  final Tether tether;

  const _PickUpBody({required this.tether});

  @override
  Widget build(BuildContext context) {
    final pickUp = tether.pickUp;
    final touched = pickUp?.lastTouchedAt == null ? '' : ago(pickUp!.lastTouchedAt);
    final where = [
      if (pickUp?.areaName != null) pickUp!.areaName!,
      if (touched.isNotEmpty) 'last touched $touched',
    ].join(' · ');
    final counts = [
      if (tether.capturedCount > 0) '${tether.capturedCount} captured away',
      if (tether.spooled > 0) '${tether.spooled} waiting for Hester',
    ].join(' · ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (pickUp != null) ...[
          // The card's title is your words.
          Text(
            pickUp.title.isEmpty ? 'Untitled page' : pickUp.title,
            key: const ValueKey('tether-card-title'),
            style: writingStyle(size: 20),
          ),
          if (where.isNotEmpty) ...[const SizedBox(height: 2), QuietText(where)],
          const SizedBox(height: AeronautTheme.spacingSm),
          if (pickUp.stoppedAt != null)
            WritingQuote(pickUp.stoppedAt!, size: 17, maxLines: 4)
          else
            const QuietText('No note from the last session.'),
        ],
        if (tether.openQuestions.isNotEmpty) ...[
          const SizedBox(height: AeronautTheme.spacingMd),
          const QuietText('Open questions'),
          const SizedBox(height: 4),
          for (final q in tether.openQuestions)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(q.text, key: ValueKey('tether-q-${q.questionId}'), style: writingStyle(size: 16)),
            ),
        ],
        if (counts.isNotEmpty) ...[const SizedBox(height: AeronautTheme.spacingSm), QuietText(counts)],
      ],
    );
  }
}
