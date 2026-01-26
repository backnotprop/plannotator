# Plan de test Plannotator

## Étape 1: Configuration initiale

Cette étape configure l'environnement de développement.

- Installer les dépendances
- Configurer les variables d'environnement
- Lancer le serveur de développement

## Étape 2: Implémentation du feature

Le code doit être modifié dans plusieurs fichiers:
- `src/components/Button.tsx`
- `src/utils/helpers.ts`
- `src/styles/theme.css`

```typescript
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

## Étape 3: Tests et validation

> Important: Tous les tests doivent passer avant le merge.

| Test | Status |
|------|--------|
| Unit tests | Pending |
| E2E tests | Pending |
| Performance | Pending |
