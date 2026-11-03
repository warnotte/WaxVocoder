# WaxVocoder — la vision

> **Une voix électronique qui se joue comme un instrument, parle plusieurs langues et vit dans tous les projets : NoobSynth3, The GrandDuc Tycoon, et ceux qui viendront.**

## La grande idée : les cartes de voix

Une voix devient un petit objet portable : une **carte de voix**, une fiche texte versionnée qui décrit qui parle et comment.

```json
{
  "format": "waxvocoder-voice/1",
  "nom": "Kaos le facteur",
  "langue": "fr",
  "hauteur": 98,
  "taille": 0.92,
  "presence": 0.8,
  "intonation": 0.5,
  "robot": { "vocoder": 0.3, "accord": "quinte", "tempo": 126, "lofi": 0 },
  "caractere": { "vibrato": 0.2, "glissando": 0.03 }
}
```

- **Créée une fois, jouée partout** : WaxVocoder la fabrique, NoobSynth3 la joue au clavier, GrandDuc Tycoon la donne à un client, une page web la fait lire.
- **Générée à la demande** : à partir d’une graine, chaque client de GrandDuc reçoit une voix unique, cohérente avec sa nationalité (frontalier belge, français, allemand…). Des milliers de voix différentes sans enregistrer un seul acteur.
- **Kaos est la carte n° 1** : la mascotte du projet.

## Les quatre piliers

### 1. La voix : claire, naturelle, multilingue

- **eSpeak NG comme professeur** : le projet étant sous GPL, on mesure automatiquement les formants et les durées des phonèmes produits par eSpeak NG dans chaque langue, et on en tire les réglages du moteur au lieu de les estimer à la main. D’abord le français, ensuite les autres langues d’eSpeak NG.
- **Rythme et intonation propres à chaque langue** : syllabes régulières et allongement de fin de groupe en français, montée de continuation, descente finale.
- **Une source vocale vivante** : légères irrégularités de hauteur et d’amplitude, un peu de souffle, pour une voix moins « buzz » sans perdre son caractère électronique.

### 2. L’instrument : le clavier qui parle

- On tape un texte, puis **chaque note jouée chante la syllabe suivante**, à la hauteur de la note, aussi longtemps que la touche est tenue.
- Clavier d’ordinateur, MIDI, puis entrées hauteur et gate dans NoobSynth3 : la même interface partout.
- **Vocoder sur micro en direct** : la méthode d’origine, pour robotiser une vraie voix, déjà présente dans le moteur (`AudioVocoder`).

### 3. La partition parlante

- Un format texte pour écrire une chanson : paroles, langue, notes et mesures par ligne, style (parlé clair, chanté, robot, jouet).
- Lue par l’application, par le séquenceur de NoobSynth3 ou par un script : la démo « Kaos le facteur » généralisée.
- **Règle d’écriture apprise cette nuit** : ce qu’on doit comprendre est parlé, ou chanté lentement et sans effet ; les effets robot vont sur les accroches courtes.

### 4. La brique de référence

- **Contrats figés et versionnés** : protocole phonétique v1, cartes de voix v1, partition parlante v1.
- **Un paquet npm** (API du type `speak(texte, carte)` qui renvoie l’audio) et **une crate Rust** sans dépendance au navigateur, utilisable directement par le cœur DSP de NoobSynth3.
- Documentation et un exemple par hôte ; budget de taille (n’embarquer que les langues utiles d’eSpeak NG).

## Le banc d’essai Kaos

Chaque amélioration du moteur re-rend automatiquement le même jeu de référence : phrases test en trois langues, « Kaos le facteur », extraits du diagnostic français. On garde l’historique avant/après : **on entend le progrès**, version après version, et une régression se repère immédiatement à l’oreille comme dans les tests.

## Feuille de route

| Étape | Résultat | Comment on sait que c’est réussi |
|---|---|---|
| 1. Voix française | Calibrage par eSpeak NG, rythme et intonation du français, source vivante | Fichier avant/après : tu comprends les couplets de Kaos sans lire le texte |
| 2. Clavier qui parle | Mode jouable dans l’application, clavier et MIDI | Tu joues « Kaos, le facteur » au clavier, syllabe par syllabe |
| 3. Cartes de voix | Format v1, éditeur dans l’application, générateur à partir d’une graine | Dix clients de GrandDuc, dix voix reconnaissables |
| 4. Module NoobSynth3 | WaxVocoder comme module : texte, carte de voix, hauteur et gate | Un patch NoobSynth3 qui chante sur sa propre boîte à rythmes |
| 5. Brique publiée | Paquet npm, crate Rust, documentation, vocoder micro | GrandDuc et NoobSynth3 utilisent la même version, sans copier de code |

## Ce qui existe déjà (3 novembre 2026)

- Moteur Rust/WASM de type Klatt : 56 phonèmes (anglais, extensions françaises et allemandes), prosodie, réglage de présence.
- Transcription anglaise par CMUdict, française et allemande par eSpeak NG ; mélange de langues dans une même ligne.
- Couche robot : vocoder à 22 bandes et accords, mélodie, tempo à syllabes égales, lo-fi, taille, vibrato, glissando, préréglages.
- Vocoder sur audio externe, export WAV, scripts de rendu (`npm run render`, `npm run vocode`, `npm run demo`).
- 54 tests Rust et 46 tests TypeScript, dont des tests acoustiques et l’exécution réelle d’eSpeak NG et du processeur AudioWorklet.
- Étape 1 commencée : le français, le québécois, le belge et l’allemand suivent le rythme d’eSpeak NG (durée de chaque phonème, protocole `A1:93`) ; avant/après dans `ecoute/rythme/avant-apres.wav`, chanson `ecoute/demo/v6/`.

## Prochaine session, en deux minutes

1. Écouter `ecoute/rythme/avant-apres.wav` (bip grave : règles du moteur ; deux bips aigus : rythme d’eSpeak NG) et `ecoute/demo/v6/kaos-le-facteur-v6.mp3`.
2. Suite de l’étape 1 : l’intonation du français (courbe de hauteur d’eSpeak NG), puis la source vivante (souffle, jitter).
