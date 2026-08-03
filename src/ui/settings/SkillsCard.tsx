// Settings → Skills (ASSISTANT §6).
//
// Skills are how the user tells the assistant things Ledger cannot derive from statement files —
// what the flat is worth, that Revolut top-ups are transfers, when their fiscal year starts.
//
// Two kinds. Built-ins ship with the app and are switched on or off; user skills are vault records
// that export, undo and merge like everything else. A user skill named the same as a built-in
// shadows it, which is how a built-in gets "edited": Duplicate & edit copies the body across.
//
// The assistant only ever sees names and descriptions until it asks for a body, so a long private
// note costs nothing on the questions that do not touch it. The card says so, because "what leaves
// my device" is the question this whole feature has to keep answering.
import { useRef, useState } from 'react'
import type { Skill } from '../../model/types'
import { BUILTIN_SKILLS, normalizeName, parseFrontmatter, skillNameExists, skillsOff } from '../../assistant/skills'
import { chatAccess } from '../../assistant/config'
import { safeModeGaps } from '../../assistant/tools'
import { useRawVault, useStore } from '../store'
import { ACCENT, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE } from '../theme'
import { btnGhost, hairBottom, italicNote } from '../styles'

interface Draft {
  id: string | null // null = a new skill
  name: string
  description: string
  body: string
}

export function SkillsCard() {
  const vault = useRawVault()
  const store = useStore()
  const assist = vault.settings.assist
  const safe = chatAccess(assist) === 'safe'
  const off = new Set(skillsOff(assist))
  const userSkills = vault.skills
  const shadowed = new Set(userSkills.map((s) => s.name))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState('')
  const file = useRef<HTMLInputElement | null>(null)

  const setOff = (next: string[]) =>
    store.commit(
      { kind: 'setSingletonField', collection: 'settings', field: 'assist', value: { ...assist, skillsOff: next } },
      { msg: 'Skills updated', undoable: true },
    )

  const toggleBuiltin = (name: string) =>
    setOff(off.has(name) ? [...off].filter((n) => n !== name) : [...off, name])

  const save = (d: Draft) => {
    const name = normalizeName(d.name)
    if (!name || !d.description.trim() || !d.body.trim()) {
      setNote('A skill needs a name, a one-line description and a body.')
      return
    }
    const clash = userSkills.find((s) => s.name === name && s.id !== d.id)
    if (clash) {
      setNote(`You already have a skill called “${name}”.`)
      return
    }
    if (d.id) {
      store.commit(
        {
          kind: 'batch',
          ops: [
            { kind: 'setField', collection: 'skills', id: d.id, field: 'name', value: name },
            { kind: 'setField', collection: 'skills', id: d.id, field: 'description', value: d.description.trim() },
            { kind: 'setField', collection: 'skills', id: d.id, field: 'body', value: d.body.trim() },
          ],
        },
        { msg: `Skill “${name}” saved`, undoable: true },
      )
    } else {
      store.commit(
        { kind: 'addSkill', skill: { name, description: d.description.trim(), body: d.body.trim() } },
        { msg: `Skill “${name}” added`, undoable: true },
      )
    }
    setDraft(null)
    setNote('')
  }

  const remove = (s: Skill) =>
    store.commit({ kind: 'delete', collection: 'skills', ids: [s.id] }, { msg: `Skill “${s.name}” deleted`, undoable: true })

  const exportSkill = (s: Skill) => {
    const text = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${s.name}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importFile = async (f: File) => {
    const parsed = parseFrontmatter(await f.text())
    if (!parsed) {
      // Reported, never silently accepted as a nameless skill the model would then ignore.
      setNote(`${f.name} has no usable frontmatter. It needs a leading --- block with name and description.`)
      return
    }
    // Refuse a name already taken by a built-in or a user skill: an imported file must not silently
    // shadow a skill the assistant trusts. Rejected at the door rather than opened for editing.
    if (skillNameExists(parsed.name, userSkills)) {
      setNote(`A skill named “${parsed.name}” already exists. Import it under a different name.`)
      return
    }
    setNote('')
    setDraft({ id: null, ...parsed })
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="skills-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Assistant skills</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-testid="skill-import" onClick={() => file.current?.click()} className="hov-ink" style={{ ...btnGhost, fontSize: 11 }}>
            Import .md
          </button>
          <button
            data-testid="skill-new"
            onClick={() => setDraft({ id: null, name: '', description: '', body: '' })}
            className="hov-ink"
            style={{ ...btnGhost, fontSize: 11 }}
          >
            New
          </button>
        </div>
      </div>
      <input
        ref={file}
        data-testid="skill-file"
        type="file"
        accept=".md,text/markdown"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void importFile(f)
        }}
      />

      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4, lineHeight: 1.5 }}>
        Notes the assistant can read when a question needs them — valuations, house rules, conventions this app cannot
        work out on its own. It sees the names and descriptions below, and fetches a body only when it decides that
        skill is relevant.
      </div>
      {safe && (
        <div data-testid="skills-safe-note" style={{ fontSize: 11.5, color: MUT, marginTop: 6, lineHeight: 1.5 }}>
          Access is Safe, so the assistant reads no amounts from your data. Skills are the exception: you wrote them, and
          they are sent whatever the access level, figures and all. A skill marked “safe mode ⚠” asks for a tool that is
          withheld right now; the rest of it still applies.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        {BUILTIN_SKILLS.map((b) => {
          const isShadowed = shadowed.has(b.name)
          const enabled = !off.has(b.name) && !isShadowed
          return (
            <Row
              key={b.name}
              name={b.name}
              description={isShadowed ? 'Replaced by your own skill of the same name.' : b.description}
              tag="built-in"
              dim={!enabled}
              gaps={safe && enabled ? safeModeGaps(b.body) : undefined}
            >
              {!isShadowed && (
                <>
                  <button
                    data-testid={`skill-copy-${b.name}`}
                    onClick={() => setDraft({ id: null, name: b.name, description: b.description, body: b.body })}
                    className="hov-ink"
                    style={{ ...btnGhost, fontSize: 10.5 }}
                    title="Copy into your own skills, where you can edit it"
                  >
                    Duplicate & edit
                  </button>
                  <button
                    data-testid={`skill-toggle-${b.name}`}
                    onClick={() => toggleBuiltin(b.name)}
                    className="hov-ink"
                    style={{ ...btnGhost, fontSize: 10.5, color: enabled ? ACCENT : FAINT }}
                  >
                    {enabled ? 'On' : 'Off'}
                  </button>
                </>
              )}
            </Row>
          )
        })}

        {userSkills.map((s) => (
          <Row
            key={s.id}
            name={s.name}
            description={s.description}
            tag="yours"
            dim={s.enabled === false}
            gaps={safe && s.enabled !== false ? safeModeGaps(s.body) : undefined}
          >
            <button
              data-testid={`skill-edit-${s.name}`}
              onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, body: s.body })}
              className="hov-ink"
              style={{ ...btnGhost, fontSize: 10.5 }}
            >
              Edit
            </button>
            <button onClick={() => exportSkill(s)} className="hov-ink" style={{ ...btnGhost, fontSize: 10.5 }}>
              Export
            </button>
            <button
              data-testid={`skill-delete-${s.name}`}
              onClick={() => remove(s)}
              className="hov-ink"
              style={{ ...btnGhost, fontSize: 10.5 }}
            >
              Delete
            </button>
          </Row>
        ))}
      </div>

      {note && (
        <div data-testid="skill-note" style={{ fontSize: 11.5, color: MUT, marginTop: 8, lineHeight: 1.5 }}>
          {note}
        </div>
      )}

      {draft && <Editor draft={draft} onChange={setDraft} onSave={() => save(draft)} onCancel={() => { setDraft(null); setNote('') }} />}

      {!draft && <div style={{ ...italicNote, marginTop: 8 }}>Your skills are stored encrypted in the vault and sync with it.</div>}
    </div>
  )
}

function Row({
  name,
  description,
  tag,
  dim,
  gaps,
  children,
}: {
  name: string
  description: string
  tag: string
  dim?: boolean
  /** Tools this skill's text leans on that safe mode withholds; empty in full access. */
  gaps?: string[]
  children?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', opacity: dim ? 0.5 : 1, ...hairBottom }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600 }}>{name}</span>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.08em', color: FAINT, textTransform: 'uppercase' }}>{tag}</span>
          {!!gaps?.length && (
            <span
              data-testid={`skill-gap-${name}`}
              title={`This skill tells the assistant to use ${gaps.join(', ')} — withheld while access is Safe, so parts of it cannot be followed as written.`}
              style={{ fontSize: 10.5, color: MUT, cursor: 'help' }}
            >
              safe mode ⚠
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: MUT, marginTop: 2, lineHeight: 1.45 }}>{description}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>{children}</div>
    </div>
  )
}

function Editor({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div data-testid="skill-editor" style={{ border: `1px solid ${HAIR}`, borderRadius: 6, padding: 10, marginTop: 10, background: SURFACE, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <input
        data-testid="skill-name"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder="short-name"
        style={{ ...ctrl, fontFamily: MONO }}
      />
      <input
        data-testid="skill-description"
        value={draft.description}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
        placeholder="One line telling the assistant when this is relevant"
        style={ctrl}
      />
      <textarea
        data-testid="skill-body"
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        rows={8}
        placeholder="The note itself. Markdown is fine."
        style={{ ...ctrl, resize: 'vertical', lineHeight: 1.5 }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-testid="skill-save" onClick={onSave} style={{ ...btnGhost, color: GREEN }} className="hov-ink">
          Save
        </button>
        <button data-testid="skill-cancel" onClick={onCancel} className="hov-ink" style={btnGhost}>
          Cancel
        </button>
      </div>
    </div>
  )
}

const ctrl = {
  fontSize: 12,
  fontFamily: 'inherit',
  padding: '6px 9px',
  border: `1px solid ${HAIR}`,
  borderRadius: 5,
  background: 'var(--surface)',
  color: INK,
  width: '100%',
  boxSizing: 'border-box' as const,
}
