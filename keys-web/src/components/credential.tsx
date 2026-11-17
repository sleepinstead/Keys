import type { ReactNode } from 'react';
import { Asterisk, Hash } from 'lucide-react';
import type { Credential, CredentialType } from '../../shared/types.ts';
import { Segmented } from './ui.tsx';

// ------------------------------------------------------------------ picker

export interface CredentialChoice {
  type: CredentialType;
  pinLength: 4 | 6;
}

export const choiceFromCredential = (c: Credential): CredentialChoice => ({ type: c.type, pinLength: c.type === 'pin' && c.length === 4 ? 4 : 6 });

export const CREDENTIAL_NAMES: Record<CredentialType, string> = {
  password: 'master password',
  pin: 'PIN',
};

const KINDS: { value: CredentialType; label: string; icon: ReactNode }[] = [
  { value: 'password', label: 'Password', icon: <Asterisk size={14} /> },
  { value: 'pin', label: 'PIN', icon: <Hash size={14} /> },
];

function describe(choice: CredentialChoice): { text: string; strength: string; tone: 'good' | 'warn' | 'bad' } {
  switch (choice.type) {
    case 'password':
      return { text: '10 or more characters, any mix.', strength: 'Strongest', tone: 'good' };
    case 'pin':
      return {
        text: 'Easy to crack if someone copies your file.',
        strength: choice.pinLength === 6 ? 'Weaker' : 'Weakest',
        tone: choice.pinLength === 4 ? 'bad' : 'warn',
      };
  }
}

/** Choose how the vault unlocks: a master password, or a 4- or 6-digit PIN. */
export function CredentialPicker({ value, onChange }: { value: CredentialChoice; onChange: (c: CredentialChoice) => void }) {
  const d = describe(value);
  return (
    <div className="cred-picker">
      <Segmented
        label="Unlock with"
        block
        value={value.type}
        onChange={(type) => onChange({ ...value, type })}
        options={KINDS.map((k) => ({ value: k.value, label: <>{k.icon}{k.label}</> }))}
      />
      {value.type === 'pin' && (
        <Segmented
          label="PIN length"
          size="sm"
          value={String(value.pinLength) as '4' | '6'}
          onChange={(v) => onChange({ ...value, pinLength: Number(v) as 4 | 6 })}
          options={[
            { value: '6', label: '6 digits' },
            { value: '4', label: '4 digits' },
          ]}
        />
      )}
      <p className="cred-desc">
        <span className="badge" data-tone={d.tone}>
          {d.strength}
        </span>
        {d.text}
      </p>
    </div>
  );
}
