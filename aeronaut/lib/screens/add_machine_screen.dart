import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../models/machine.dart';
import '../providers/machines_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Form for adding a new machine via manual entry.
///
/// QR scanning will be added in a later milestone.
class AddMachineScreen extends ConsumerStatefulWidget {
  const AddMachineScreen({super.key});

  @override
  ConsumerState<AddMachineScreen> createState() => _AddMachineScreenState();
}

class _AddMachineScreenState extends ConsumerState<AddMachineScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _hostController = TextEditingController();
  final _hostPortController = TextEditingController(text: '9001');
  final _hesterPortController = TextEditingController(text: '9000');
  final _tokenController = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _nameController.dispose();
    _hostController.dispose();
    _hostPortController.dispose();
    _hesterPortController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _saving = true);

    final machine = Machine(
      id: const Uuid().v4(),
      name: _nameController.text.trim(),
      host: _hostController.text.trim(),
      hostPort: int.tryParse(_hostPortController.text) ?? 9001,
      hesterPort: _hesterPortController.text.isNotEmpty
          ? int.tryParse(_hesterPortController.text)
          : null,
      token: _tokenController.text.trim(),
    );

    await ref.read(machinesProvider.notifier).addMachine(machine);

    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Add Machine'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(AeronautTheme.spacingMd),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Name
              TextFormField(
                controller: _nameController,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  hintText: 'MacBook Pro',
                ),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Required' : null,
                textInputAction: TextInputAction.next,
              ),
              const SizedBox(height: AeronautTheme.spacingMd),

              // Host
              TextFormField(
                controller: _hostController,
                decoration: const InputDecoration(
                  labelText: 'Host',
                  hintText: '192.168.1.100',
                ),
                validator: (v) =>
                    (v == null || v.trim().isEmpty) ? 'Required' : null,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.next,
              ),
              const SizedBox(height: AeronautTheme.spacingMd),

              // Ports row
              Row(
                children: [
                  Expanded(
                    child: TextFormField(
                      controller: _hostPortController,
                      decoration: const InputDecoration(
                        labelText: 'Host Port',
                        hintText: '9001',
                      ),
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.next,
                    ),
                  ),
                  const SizedBox(width: AeronautTheme.spacingMd),
                  Expanded(
                    child: TextFormField(
                      controller: _hesterPortController,
                      decoration: const InputDecoration(
                        labelText: 'Hester Port',
                        hintText: '9000 (optional)',
                      ),
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.next,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AeronautTheme.spacingMd),

              // Token
              TextFormField(
                controller: _tokenController,
                decoration: const InputDecoration(
                  labelText: 'Token',
                  hintText: 'Bearer token (optional)',
                ),
                obscureText: true,
                textInputAction: TextInputAction.done,
                onFieldSubmitted: (_) => _save(),
              ),
              const SizedBox(height: AeronautTheme.spacingSm),
              Text(
                'Found in ~/.lee/aeronaut.token on the target machine.',
                style: AeronautTheme.caption.copyWith(
                  color: AeronautColors.textTertiary,
                ),
              ),
              const SizedBox(height: AeronautTheme.spacingXl),

              // Save button
              ElevatedButton(
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Add Machine'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
