import { describe, it, expect } from 'vitest'
import { lookupQuery } from '../../src/import/lookup'

describe('lookupQuery', () => {
  it('keeps the card merchant, drops the card number and the DU date', () => {
    const q = lookupQuery('STARBUCKS LONDON', 'FACTURE(S) CARTE 4974XXXXXX7214 DU 140725 STARBUCKS LONDON GB')
    expect(q).toContain('STARBUCKS LONDON')
    expect(q).not.toContain('4974')
    expect(q).not.toMatch(/\d{6}/) // no DU date / card digits survive
    expect(q).not.toMatch(/\bCARTE\b/i)
  })

  it('strips SEPA creditor id, IBAN, REF and the ECH due-date, merchant survives', () => {
    const raw = 'PRLV SEPA NETFLIX INTERNATIONAL ECH/250714 ID EMETTEUR EMETTEUR/NL99ZZZ123456789 REF/ABC12345XYZ FR7699999000041234567890185'
    const q = lookupQuery('NETFLIX', raw)
    expect(q).toContain('NETFLIX')
    expect(q).not.toContain('EMETTEUR/NL99')
    expect(q).not.toContain('FR7699999')
    expect(q).not.toContain('ABC12345XYZ')
    expect(q).not.toMatch(/\d{6}/)
  })

  it('keeps the brand for a noisy card row, dropping boilerplate and the amount', () => {
    const q = lookupQuery('UBER *TRIP', 'UBER *TRIP PAIEMENT CB DU UBER TRIP NLD 41,98EUR')
    expect(q).toContain('UBER')
    expect(q).not.toMatch(/\bPAIEMENT\b/i)
    expect(q).not.toContain('41,98')
    expect(q).not.toMatch(/\bEUR\b/)
  })

  it('returns empty when nothing searchable remains (card validation)', () => {
    expect(lookupQuery('PAIEMENT CB DU KUUVD1WIOVHK TX VALIDATION CB', 'PAIEMENT CB DU KUUVD1WIOVHK TX VALIDATION CB')).toBe('')
  })

  it('drops generic transfer verbs but keeps the counterparty name', () => {
    const q = lookupQuery('Virement reçu', 'VIREMENT SEPA RECU /DE JOHN DOE /MOTIF LOAN')
    expect(q).toContain('JOHN DOE')
    expect(q).not.toMatch(/\bVIREMENT\b/i)
  })

  it('returns the merchant when there is no raw descriptor', () => {
    expect(lookupQuery('Bought coffee')).toBe('Bought coffee')
    expect(lookupQuery('  Manual entry  ')).toBe('Manual entry')
  })

  it('caps the query at 90 chars', () => {
    const raw = 'SUPERMARKET ' + 'zilch '.repeat(60)
    expect(lookupQuery('SUPERMARKET', raw).length).toBeLessThanOrEqual(90)
  })
})
