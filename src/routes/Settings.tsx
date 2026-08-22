import { ChevronLeft, LogOut } from 'lucide-react'
import { useId } from 'react'
import { Link, Navigate } from 'react-router-dom'

import { ServerCard } from '@/components/ServerCard'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useSettings } from '@/hooks/useLibrary'
import { setLlmModel, setSttModel, transcriptionModels } from '@/lib/settings'
import { useAuth } from '@/stores/auth'

/**
 * Server health, the two model pickers, and sign-out (`SPEC §8`). Export lands with
 * M7.
 *
 * Native `<select>` on purpose: on the phone this is built for, a real select is the
 * system wheel picker — one thumb, no portal, nothing to scroll-lock. The model lists
 * come from `lastHealth`, which the `serverHealth` function caches into the settings
 * document, so they fill in on their own after a check.
 */

interface ModelPickerProps {
  label: string
  hint: string
  /** Null = auto-pick. `'none'` = off, and only the cleanup picker offers it. */
  value: string | null
  available: string[]
  offLabel?: string
  onChange: (value: string | null) => void
}

function ModelPicker({ label, hint, value, available, offLabel, onChange }: ModelPickerProps) {
  const id = useId()

  // A pinned model the server has stopped listing still has to appear, or the select
  // would quietly show something else as chosen and the rename would be invisible.
  const pinned = value !== null && value !== 'none' ? value : null
  const options = pinned && !available.includes(pinned) ? [...available, pinned] : available

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <NativeSelect
        id={id}
        className="w-full"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <NativeSelectOption value="">Auto</NativeSelectOption>
        {offLabel ? <NativeSelectOption value="none">{offLabel}</NativeSelectOption> : null}
        {options.map((model) => (
          <NativeSelectOption key={model} value={model}>
            {available.includes(model) ? model : `${model} — no longer on the server`}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  )
}

export function Settings() {
  const user = useAuth((s) => s.user)
  const signOut = useAuth((s) => s.signOut)
  const uid = user?.uid ?? null
  const settings = useSettings(uid)

  if (!uid) return <Navigate to="/" replace />

  const health = settings?.lastHealth ?? null
  const sttAll = health?.stt ?? []
  const sttUsable = transcriptionModels(sttAll)
  const excluded = sttAll.length - sttUsable.length

  return (
    <div className="mx-auto flex min-h-[var(--app-height)] w-full max-w-md flex-col gap-6 px-5 py-6">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="flex-1 font-semibold">Settings</h1>
      </header>

      <ServerCard cached={health} />

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <ModelPicker
            label="Transcription"
            hint="Auto picks the first Whisper model the server lists."
            value={settings?.sttModel ?? null}
            available={sttUsable}
            onChange={(value) => void setSttModel(uid, value)}
          />
          {/* Named rather than hidden: the server really does list a TTS voice and a
              VAD model here, and knowing they were left out is more useful than
              wondering where they went. */}
          {excluded > 0 ? (
            <p className="text-muted-foreground text-xs">
              {excluded} other model{excluded === 1 ? '' : 's'} on the server{' '}
              {excluded === 1 ? 'is not a transcription model' : 'are not transcription models'}.
            </p>
          ) : null}
        </div>

        <ModelPicker
          label="Cleanup"
          hint="Auto picks the first model the server lists. Off keeps the filler strip and skips the polish entirely."
          value={settings?.llmModel ?? null}
          available={health?.llm ?? []}
          offLabel="Off — filler strip only"
          onChange={(value) => void setLlmModel(uid, value)}
        />

        {health === null ? (
          <p className="text-muted-foreground text-xs">
            Check the server above to list the models it actually has. Until then both
            pickers can only offer Auto.
          </p>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t pt-4">
        <p className="text-muted-foreground truncate text-xs">
          {user?.email ?? user?.displayName ?? 'Signed in'}
        </p>
        <Button variant="outline" onClick={() => void signOut()} className="self-start">
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </div>
  )
}
