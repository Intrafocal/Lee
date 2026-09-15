import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/auth_provider.dart';
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
    // Install the 401 guard before anything can make a request, then load
    // machines from disk and start health pings.
    ref.read(authGuardProvider.notifier);
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
