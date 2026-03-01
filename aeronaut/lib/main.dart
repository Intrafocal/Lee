import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'providers/machines_provider.dart';
import 'services/machine_store.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize the machine store before running the app
  final store = MachineStore();
  await store.init();

  runApp(
    ProviderScope(
      overrides: [
        machineStoreProvider.overrideWithValue(store),
      ],
      child: const AeronautApp(),
    ),
  );
}
