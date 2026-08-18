const IDENTITY_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const IDENTITY_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

export function hasValidIdentityChecksum(identityNumber: string): boolean {
  const normalized = identityNumber.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(normalized)) return false;

  const checksum = normalized
    .slice(0, 17)
    .split('')
    .reduce((total, character, index) => total + Number(character) * IDENTITY_WEIGHTS[index], 0);

  return normalized[17] === IDENTITY_CHECK_CODES[checksum % 11];
}
