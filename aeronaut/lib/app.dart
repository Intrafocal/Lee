import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/machines_provider.dart';
import 'screens/machines_screen.dart';
import 'theme/aeronaut_theme.dart';

/// Root Aeronaut application widget.
class AeronautApp extends ConsumerStatefulWidget {
  const AeronautApp({super.key});

  @override
  ConsumerState<AeronautApp> createState() => _AeronautAppState();
}

class _AeronautAppState extends ConsumerState<AeronautApp> {
  @override
  void initState() {
    super.initState();
    // Initialize machines provider (loads from disk + starts health pings)
    Future.microtask(() {
      ref.read(machinesProvider.notifier).init();
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Aeronaut',
      debugShowCheckedModeBanner: false,
      theme: AeronautTheme.darkTheme,
      home: const MachinesScreen(),
    );
  }
}
