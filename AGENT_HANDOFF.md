# Revue croisée des agents — intelligibilité de WaxVocoder

## But

Rendre la parole de WaxVocoder réellement intelligible tout en gardant le projet indépendant et intégrable plus tard dans NoobSynth3. L’agent qui prend cette tâche en charge doit faire l’analyse et l’implémentation nécessaires dans le dépôt.

## État du projet

- Application web TypeScript/Vite, AudioWorklet et moteur DSP Rust compilé en WASM.
- Le moteur actuel produit des sons de phonèmes synthétiques avec trois résonateurs formantiques. Les transitions et tests ont été améliorés, mais la parole n’est pas encore intelligible.
- La conversion texte → phonèmes dans `src/phonemes.ts` est une règle orthographique de démonstration, avec une exception pour « Kraftwerk » ; elle ne constitue pas un vrai système de prononciation.
- Le projet doit rester autonome. NoobSynth3 est une cible d’intégration future, pas une dépendance qui doit dicter les choix actuels.
- Vérifications récemment réussies : `npm test` (6 tests Rust et 9 TypeScript), `npm run build`, tests Rust debug/release et `cargo fmt --check`. Clippy a un avertissement de placement du module de tests.

## Question à examiner

Quelle architecture permet d’obtenir rapidement une prononciation crédible, puis une voix électronique contrôlable, sans enfermer le projet dans un choix difficile à remplacer ?

Comparer au minimum ces options :

1. eSpeak NG pour texte → phonèmes uniquement, puis moteur WaxVocoder pour le rendu.
2. eSpeak NG pour générer une voix source, puis traitement/vocoder WaxVocoder.
3. Garder une synthèse maison, mais remplacer la transcription approximative et améliorer le modèle phonétique/formantique.

## Travail attendu de l’agent

- Examiner les options (eSpeak NG pour phonèmes, source vocale ou autre approche) et vérifier la faisabilité, la licence, le fonctionnement navigateur/WASM et le contrôle phonétique.
- Choisir l’approche la plus pragmatique pour obtenir une parole nettement plus intelligible, sans coupler le projet à NoobSynth3.
- Implémenter un prototype fonctionnel dans ce dépôt, y compris les changements nécessaires à l’interface, au moteur et aux dépendances. Garder une API réutilisable si cela reste raisonnable.
- Ajouter ou adapter les tests pertinents et lancer les builds/tests disponibles. Corriger les régressions rencontrées.
- Ne pas s’arrêter à une recommandation ou demander à l’autre agent de faire l’implémentation. Si une contrainte bloque réellement, expliquer précisément laquelle et livrer le meilleur résultat partiel utile.
- À la fin, écrire un compte rendu court : approche retenue, fichiers majeurs modifiés, commandes vérifiées, limites connues et sources/licence.

Réponse courte souhaitée (10 puces maximum), mais le travail d’analyse et de code doit être complet. Ne pas dépenser la réponse à résumer l’historique du dépôt.

## Réponse de l’agent

Consigne : exécute le travail attendu ci-dessus. La limite de longueur concerne uniquement ton compte rendu final, pas l’analyse, les modifications ou les vérifications.

Agent / date : Claude Code (Claude Opus 5.5) / 2026-11-03

### Approche retenue et raisons

- **Option 3 avec la frontière de l’option 1** : CMUdict pour la transcription anglaise, puis un nouveau rendu de type Klatt en Rust, reliés par un protocole ARPAbet en texte (`W IY1 | AA1 R …`) qui permet de remplacer ensuite le front-end (eSpeak NG, autre langue, édition manuelle) sans toucher au moteur. Raisons : le goulot était le rendu (P/T/K, S/F/SH, B/D/G et V/Z avaient des paramètres identiques dans l’ancien moteur), eSpeak NG (GPL-3.0-or-later) imposerait la GPL à l’application distribuée, une décision réservée au propriétaire, et l’option 2 contournerait le moteur en figeant timbre et timing dans eSpeak.

### Éléments vérifiés et sources

- eSpeak NG : GPL-3.0-or-later, plus de 100 langues, dernière version 1.52.0 du 2024-12-12, dossier `emscripten/` officiel ([dépôt](https://github.com/espeak-ng/espeak-ng)) ; builds WASM npm de 2,6 Mo (`phonemizer`, anglais seul, étiqueté Apache-2.0 mais embarquant eSpeak NG) à 25 Mo (`@echogarden/espeak-ng-emscripten`). Non exécuté ici : l’exécution du paquet téléchargé a été refusée par les permissions de la session.
- CMUdict : licence de type BSD de Carnegie Mellon University ([LICENSE](https://github.com/cmusphinx/cmudict/blob/master/LICENSE)), fichier source au commit `0f8072f8`, 126 052 mots conservés (première prononciation), notice incluse dans `src/data/`.
- Intelligibilité vérifiée par mesures acoustiques, pas par écoute : spectres distincts selon le lieu d’articulation (S au-dessus de 4 kHz, SH à 2–4 kHz ; explosion de T aiguë, de K compacte, de P diffuse), silence d’occlusion de 40 ms ou plus, aspiration de P (+50 ms par rapport à B, absente après S), formants vocaliques, diphtongues, murmure nasal 9 dB sous la voyelle, intonation. Un test d’identification de mots par MFCC + DTW contre la voix Windows Zira donne 37 % pour le nouveau moteur contre 22 à 32 % pour l’ancien (hasard ≈ 10 %), mais une vraie voix de synthèse d’un autre locuteur n’y obtient que 39 % : ce test n’est pas concluant.

### Implémentation réalisée

- Moteur `crates/voice-engine` v0.2.0 : `phonemes.rs` (39 phonèmes et protocole), `planner.rs` (durées, accent, allongement final, occlusion, explosion, aspiration, transitions, contour de hauteur), `synth.rs` (source de Rosenberg, cascade F1–F5 avec pôle et zéro nasals, banc de friction parallèle), `voice.rs` (API native `Voice`), `wasm.rs` (`VoiceEngine`, fonctionnalité `wasm` désactivable pour un hôte natif). WASM de 58 Ko.
- Interface : `src/phonemes.ts` (CMUdict, règles de repli, ponctuation, validation), `src/dictionary.ts`, `src/data/cmudict.txt` (3,3 Mo, 0,9 Mo en gzip), `src/main.ts` et `index.html` (hauteur, débit, intonation, export WAV), worklet et polyfills `TextEncoder`/`TextDecoder`, `scripts/render-phrase.ts` (`npm run render`), `scripts/build-dictionary.mjs`.
- Commandes vérifiées : `npm test` (29 tests Rust, 18 TypeScript, dont le vrai processeur AudioWorklet sans `TextEncoder` natif), `npm run build`, `cargo fmt --check`, `cargo clippy --all-targets` (0 avertissement), tests Rust en release et avec `--no-default-features`.

### Questions restantes

- Valider à l’oreille : paires avant/après dans `ecoute/` (ignoré par git, supprimable) ; seule une écoute, idéalement à l’aveugle, peut confirmer que la parole est « nettement plus intelligible ».
- Limites : anglais seul, pas de nombres ni d’homographes (« read » est toujours /rɛd/), une seule voix masculine, pas encore de vocoder ni de porteuse. Pour le français, il faut choisir entre eSpeak NG (GPL) et un lexique dont la licence doit être clarifiée (Lexique affiche CC BY-SA 4.0 mais renvoie vers CC BY-NC 4.0). NoobSynth3 n’a aucune licence déclarée.

## Décisions du propriétaire

À compléter par le propriétaire après comparaison des avis. Les agents ne prennent pas de décision produit au nom du propriétaire.

- 2026-11-03 01:12 UTC — décisions communiquées par le propriétaire à Claude Code, retranscrites à sa demande :
  1. Le prototype livré (CMUdict + moteur de type Klatt) est validé.
  2. La GPL est acceptée : WaxVocoder passe sous GPL-3.0-or-later afin d’intégrer eSpeak NG.
  3. eSpeak NG sert **uniquement à la transcription** (texte → phonèmes, multilingue, notamment le français) ; le rendu sonore reste assuré par le moteur WaxVocoder.
