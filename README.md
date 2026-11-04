# Wax Vocoder

Instrument vocal musical autonome — texte, phonèmes, synthèse vocale électronique, vocoder et effets de robot.

Le projet est indépendant de NoobSynth3. Son moteur Rust/WASM est conçu pour pouvoir être réutilisé par d’autres interfaces et hôtes ultérieurement.

Cap et feuille de route : [`docs/VISION.md`](docs/VISION.md) — cartes de voix, clavier qui parle, partition parlante, brique réutilisable par NoobSynth3, The GrandDuc Tycoon et les projets suivants.

## Architecture

```text
texte ──► transcription ──────────────────────────► protocole phonétique ──► moteur Rust (crates/voice-engine)
          anglais : CMUdict + règles (phonemes.ts)    texte éditable           planification → synthèse Klatt → vocoder → lo-fi
          français, allemand : eSpeak NG → IPA → ipa.ts
```

- `src/phonemes.ts` : transcription anglaise. Les mots viennent du CMU Pronouncing Dictionary (`src/data/cmudict.txt`, 126 052 mots, chargé au démarrage) ; les mots absents passent par des règles orthographiques approximatives ; « Kraftwerk » a une prononciation dédiée.
- `src/espeak.ts` et `src/ipa.ts` : transcription française et allemande par eSpeak NG (build wasm2js, chargé à la première utilisation, ≈ 25 Mo). Le texte est découpé à la ponctuation, chaque proposition est transcrite en API puis convertie vers le protocole (voyelles nasales, /ʁ/, /ç/, /y/ /ø/ /œ/, glissante /ɥ/ ; en français, accent sur la fin de groupe et voyelles inaccentuées non réduites). **Rythme de la langue** : `transcribeTimed` fait aussi parler eSpeak NG et relève la durée de chaque phonème dans ses événements de synthèse ; le silence d’occlusion des /p t k/, qu’eSpeak range dans le phonème précédent, est mesuré dans son audio et rendu à la consonne ; les consonnes trop brèves pour le moteur (/ʁ/ fondu entre deux voyelles) prennent un peu de temps à la voyelle voisine. Le moteur suit alors ces durées au lieu de ses règles génériques (débit et allongements du français ou de l’allemand). Une proposition dont les événements ne correspondent pas à l’API garde les règles. eSpeak NG n’a pas de voix québécoise : le québécois utilise la voix française, WaxVocoder ajoute l’assibilation [ts] [dz] ; une voix absente lève une erreur au lieu de garder silencieusement la précédente.
- Protocole phonétique, partagé par tous les hôtes : symboles séparés par des espaces (`W EH1 L K AH0 M .`). Les 39 premiers symboles sont l’ARPAbet de CMUdict ; 17 extensions couvrent le français et l’allemand (`E A O U UE EU OE AX`, voyelles nasales `AN ON IN UN`, `RX` /ʁ/, `NY` /ɲ/, `UY` /ɥ/, `X` /x/, `CC` /ç/). Chiffre d’accent sur les voyelles (`1` principal, `2` secondaire, `0` atone), `|` frontière de mot sans silence, `_` courte pause, `,` `;` `:` pause de groupe, `.` `!` fin descendante, `?` fin montante. Durée facultative en millisecondes entières après deux-points collés au symbole (`K:42 A2:93`, 1 à 5000 ms) : elle remplace les règles de durée pour ce phonème (le débit la divise toujours) ; un `:` suivi d’autre chose qu’un chiffre reste une pause. Le moteur ignore et compte les symboles inconnus.
- `crates/voice-engine/` : moteur DSP sans dépendance à l’interface.
  - `phonemes.rs` : inventaire (cibles de formants, largeurs de bande, durées, spectres de friction, nasalisation) et analyse du protocole.
  - `planner.rs` : durées, occlusives (silence, explosion, aspiration selon la langue), transitions de formants, intonation ; en mode robot, grille rythmique et mélodie.
  - `synth.rs` : synthèse de type Klatt (onde glottique de Rosenberg ou impulsion « buzz », cascade F1–F5 avec pôle et zéro nasals, banc de friction parallèle), notes, quantification, glissando, vibrato, décalage des formants.
  - `effects.rs` : vocoder à 22 bandes (porteuse en dents de scie anti-repliement, accords, bruit dans les aigus pour garder les sifflantes), réducteur lo-fi (échantillonnage bloqué, bits) et `AudioVocoder` pour un audio externe (bande de la voix vocodée, basses et aigus conservés, niveau ajusté automatiquement).
  - `melody.rs` : notes anglaises (`C3`, `D#3`, `Bb2`, A4 = 440 Hz) ou françaises (`do2`, `ré#2`, `sib1`, la3 = 440 Hz).
  - `voice.rs` : API Rust native `Voice` ; `wasm.rs` : liaison `VoiceEngine` derrière la fonctionnalité `wasm` (active par défaut, désactivable avec `default-features = false` pour un hôte natif).
- `src/voice-settings.ts` : réglages partagés par l’interface, le worklet et les scripts, et préréglages.
- `src/audio/` : AudioWorklet, polyfills `TextEncoder`/`TextDecoder` pour l’AudioWorkletGlobalScope, export WAV.

## Moteurs de voix

Le menu « Moteur » choisit qui parle ; l’étage robot (vocoder, hauteur de la porteuse, accord) s’applique à tous :

- **WaxVocoder** : la voix à formants du moteur Rust (temps réel, robot, chant note par note, tempo, tous les réglages).
- **eSpeak NG** : la voix d’eSpeak NG elle-même (déjà chargé pour la transcription).
- **Piper** : voix neuronales naturelles, entraînées sur de vrais locuteurs (`src/engines/piper.ts`, ONNX Runtime Web 1.30.0 en WASM, phonèmes par le même eSpeak NG). Menu « Voix » : en français Siwis (CC BY 4.0, SIWIS, université d’Édimbourg), Tom (AGPL-3.0), Pierre et Jessica (CC BY-SA 4.0, UPMC) ; en anglais Joe (CC0) ; en allemand Thorsten (CC0). Chaque voix (≈ 63 à 77 Mo) est téléchargée au premier usage depuis `voices/<id>/` à côté de la page s’il existe, sinon depuis Hugging Face (`rhasspy/piper-voices`). Écartées : `fr_FR-gilles-low` (pas de voyelles nasales), `fr_FR-mls` (125 voix inégales), et les voix sous licence non commerciale (lessac, ryan, hfc).

Une voix Piper passée dans le vocoder, c’est la méthode des robots de Kraftwerk (une vraie voix dans un vocoder). Avec eSpeak NG et Piper, les réglages propres à WaxVocoder (mélodie, tempo, intonation, taille…) sont sans effet.

```sh
npm run voice -- fr     # télécharge les voix Piper d’une langue (fr, en, de) dans voices/ (scripts, tests, serveur de développement)
npm run engines        # la même phrase avec chaque moteur, puis dans le vocoder → ecoute/moteurs/comparaison.wav
```

## Robot et effets

| Préréglage | Effet |
|---|---|
| Robot Kraftwerk | voix monotone quantifiée, vocoder en dents de scie à l’octave grave, syllabes calées sur 112 BPM avec coupures entre les mots |
| Robot chanteur | une note par syllabe, vocoder quinte + octave, 100 BPM |
| Jouet parlant 1980 | source « buzz », échantillonnage réduit vers 6 kHz et peu de bits |
| Petit robot / Robot géant | formants décalés vers le haut ou le bas, voix aiguë ou grave |
| Robot en panne | vibrato et glissando exagérés, un peu de lo-fi |

Chaque réglage reste ajustable : présence (attaque glottale plus nette, consonnes plus fortes, aigus au-dessus de 2 kHz, pour que la voix passe dans un mix ; 50 % par défaut dans l’interface, 0 par défaut dans le moteur), vocoder, porteuse (unisson, octave, quinte + octave, mineur, majeur, octave grave), tempo, lo-fi, taille, vibrato, glissando, mélodie et « notes justes ». Le timbre visé est inspiré des voix électroniques des années 1970–1980, sans chercher à cloner une voix ni à reproduire un enregistrement.

## Prérequis

- Node.js 24 ou plus récent.
- Rust stable avec la cible `wasm32-unknown-unknown`.
- `wasm-pack` installé.

## Démarrage

```sh
npm install
npm run build:wasm
npm run dev
```

Choisir la langue (anglais, français, québécois, belge, allemand), saisir une phrase ou corriger sa séquence phonétique, choisir un préréglage, puis « Lire la phrase ». Hors anglais, « Rythme naturel de la langue » (coché par défaut) fait suivre au moteur les durées d’eSpeak NG ; l’éditeur montre les phonèmes sans durées, et dès qu’on le modifie, c’est son contenu qui est lu. Le premier passage en français ou en allemand charge eSpeak NG (≈ 25 Mo). « Exporter WAV » rend la phrase hors temps réel à 44,1 kHz.

Sans navigateur :

```sh
npm run render -- "Welcome to the laboratory." labo.wav --preset kraftwerk
npm run render -- "Hello" hello.wav --melody "C3 G2" --vocoder 1 --chord 2 --tempo 100
npm run render -- "Bonjour, je suis une machine qui parle." bonjour.wav --lang fr --preset kraftwerk
npm run render -- "Hallo, ich bin eine sprechende Maschine." hallo.wav --lang de
npm run render -- "B ON2 ZH U1 RX ." bonjour.wav --phonemes --lang fr
npm run render -- "Le facteur arrive." facteur.wav --lang fr   # rythme d’eSpeak NG ; --rules : règles du moteur
node scripts/espeak-ipa.mjs fr "Bonjour"   # sortie API brute d’eSpeak NG
```

Vocoder sur un audio existant (voix enregistrée ou morceau entier) : la bande de la voix est vocodée sur la porteuse, les basses et les aigus passent tels quels.

```sh
ffmpeg -i morceau.mkv -vn -ar 44100 -c:a pcm_s16le morceau.wav
npm run vocode -- morceau.wav morceau-robot.wav --note F2 --chord 2 --mix 1 --split 150,6000
```

`--note` accepte les mêmes noms que la mélodie (`F2`, `fa1`…), `--mix` dose la voix d’origine (0) et la voix vocodée (1). Sur un mixage complet, tout ce qui occupe la bande (voix, claps, nappes) est vocodé : il n’y a pas de séparation de sources.

## Mise en ligne

```sh
npm run build:wasm && npm run build   # produit dist/
```

Déposer **tout le contenu** de `dist/` (y compris `.htaccess`) sur le serveur, à la racine du site ou dans n’importe quel sous-dossier : les adresses sont relatives (`base: './'`). Il n’y a rien à exécuter côté serveur, ce sont des fichiers statiques (≈ 28 Mo, dont 24 Mo de données eSpeak NG téléchargées seulement au premier passage hors anglais).

- **HTTPS obligatoire** : le navigateur n’ouvre le moteur audio (AudioWorklet) que sur une connexion sécurisée ; en HTTP, l’application l’indique au lieu de lire.
- **Partage sur les réseaux** : `index.html` porte les balises Open Graph et X/Twitter ; l’image d’aperçu (`public/og-image.png`, 1200 × 630, capturée depuis `scripts/og/card.html`) doit avoir une adresse absolue, réglée par `VITE_OG_IMAGE` dans `.env` (par défaut la copie sur GitHub, servie une fois `main` poussé ; pour ton propre site : `https://ton.site/chemin/og-image.png`). Icône : `public/favicon.svg`.
- **Piper** : la voix (≈ 63 Mo) est téléchargée par le navigateur du visiteur depuis Hugging Face au premier choix du moteur Piper. Pour ne pas dépendre de Hugging Face, déposer aussi `voices/fr_FR-siwis-medium/` (obtenu par `npm run voice -- fr`) à côté de `index.html` : la page le préfère. Le moteur ONNX Runtime (14 Mo, 3,7 Mo compressé) n’est chargé qu’à ce moment-là.
- **Apache** : `public/.htaccess` (copié dans `dist/`) déclare les types `.wasm` et `.data`, active la compression (données eSpeak NG 24 → 12 Mo, dictionnaire 3,3 → 0,9 Mo) et met en cache longue durée les fichiers d’`assets/`, dont le nom porte une empreinte.
- **nginx** : ajouter `application/wasm wasm;` aux types si besoin, et `gzip on; gzip_types application/octet-stream application/wasm text/plain text/javascript text/css;`.
- **Licences** : le pied de page renvoie au code source (GPL-3.0-or-later), à celui d’eSpeak NG et à sa licence (`assets/espeak-ng.COPYING.txt`), ce qu’exige la GPL quand on distribue l’application.

## Démo de chanson

`npm run demo` rend « Kaos le facteur », une chanson électro-pop de près de 2 minutes à 126 BPM : couplets en français (le premier sur un texte du propriétaire), pré-refrain et pont en allemand et en anglais, refrain trilingue dans une même ligne (« Kaos, le facteur / der Briefträger, the postman »), dernier refrain un ton plus haut. Le script vérifie que chaque mélodie a autant de notes que de syllabes et qu’aucune ligne ne déborde, cale la première voyelle de chaque ligne sur le temps, compresse et double la voix, creuse la musique sous la voix et pompe sur la grosse caisse. Sortie dans `ecoute/demo/` : le mix, la piste voix seule calée sur la grille (mesure 1 à t = 0) et l’accompagnement seul ; `DEMO_STEMS=1` écrit aussi les bus avant mastering. L’accompagnement n’est qu’un guide d’écoute ; le rythme et la musique ont vocation à venir de NoobSynth3.

« Datenherz » (`npm run song`, `scripts/datenherz.ts`) : chanson courte et originale en allemand, anglais et français (paroles, mélodies, riff et accords écrits pour WaxVocoder, rien n’est repris d’une chanson existante), hommage à la musique électronique allemande de 1981. Couplets dits par les voix Piper Thorsten, Joe et Tom passées dans le vocoder (une note de la mélodie par syllabe, chaque phrase calée sur deux mesures), refrain par le chœur de robots du moteur → `ecoute/datenherz/`.

Visite guidée (`npm run tour`, `scripts/visite-guidee.ts`) : la voix Piper Siwis présente chaque technique puis la fait entendre (moteurs, langues, rythme, voix Piper, vocoder et porteuses, mélodie et tempo, les treize préréglages, voix naturelle dans le vocoder, correction pop, effets, extrait de Datenherz) → `ecoute/visite/visite-guidee.wav` et `chapitres.txt`. Les effets, en Web Audio dans l’application, y sont reproduits par un équivalent hors navigateur.
## Vérifications

```sh
npm test            # régénère le WASM, puis tests Rust et TypeScript
npm run build
cargo fmt --manifest-path crates/voice-engine/Cargo.toml --check
cargo clippy --manifest-path crates/voice-engine/Cargo.toml --all-targets
```

Tests Rust : indices acoustiques de l’intelligibilité (spectres de friction et d’explosion selon le lieu d’articulation, occlusion, aspiration, formants, diphtongues, nasales, intonation, pauses, débit, fréquence d’échantillonnage, répétabilité) et couche robot (niveau, hauteur et sifflantes du vocoder, voyelles encore distinctes une fois vocodées, accords, mélodie, quantification, grille rythmique et coupures, formants, vibrato, glissando, lo-fi, règles de langue, voyelles nasales). Tests TypeScript : transcription anglaise, dictionnaire, conversion API → phonèmes sur des sorties réelles d’eSpeak NG, transcription par le vrai eSpeak NG (français, allemand, anglais : aucun son non pris en charge sur le corpus de test), compatibilité du protocole avec le WASM, préréglages rendus par le vrai moteur, export WAV et exécution du processeur AudioWorklet sans `TextEncoder`/`TextDecoder`.

## Licences

- WaxVocoder est distribué sous **GPL-3.0-or-later** (`LICENSE`), décision du propriétaire pour pouvoir intégrer eSpeak NG.
- `src/data/cmudict.txt` : dérivé du CMU Pronouncing Dictionary (https://github.com/cmusphinx/cmudict), licence de type BSD de Carnegie Mellon University, compatible avec la GPL ; notice en tête du fichier et dans `src/data/CMUDICT_LICENSE.txt`. Régénération : `node scripts/build-dictionary.mjs <cmudict.dict> <LICENSE>`.
- eSpeak NG (dépendance `@echogarden/espeak-ng-emscripten` 0.3.5, GPL-3.0) : sources correspondantes sur https://github.com/echogarden-project/espeak-ng-emscripten et la branche `fork` de https://github.com/echogarden-project/espeak-ng.

## Limites connues

- Anglais : pas de normalisation des nombres et abréviations, une seule prononciation par mot (« read » est toujours /rɛd/). Français et allemand : qualité de transcription d’eSpeak NG ; la synthèse de ces langues réutilise un modèle formantique conçu d’abord pour l’anglais.
- Navigateur : eSpeak NG cherche `espeak-ng.data` à côté de son propre script, que Vite déplace (cache de dépendances en développement, fragments hachés au build). L’application télécharge donc elle-même ce fichier (import `?url`) et le remet à eSpeak NG (`loadEspeak({ dataUrl })`, crochet Emscripten `getPreloadedPackage`) ; une page HTML reçue à la place des données lève une erreur claire. Vérifié dans Edge sans interface (serveur de développement, dépendance pré-empaquetée, build de production) : passage du français à l’allemand, au québécois et au belge. Le son lui-même n’a pas été écouté dans le navigateur par l’agent.
- Voix synthétique masculine, volontairement électronique ; le vocoder réduit la résolution spectrale (les voyelles restent distinctes, mais moins nettes qu’en voix sèche).
- L’intelligibilité a été vérifiée par des mesures acoustiques, pas par un panel d’auditeurs.
- Poids : dictionnaire CMUdict 3,3 Mo (≈ 0,9 Mo compressé en gzip) ; eSpeak NG 0,8 Mo de code et 24 Mo de données (toutes langues), chargés seulement pour le français ou l’allemand.

## À corriger (noté, pas encore touché)

Constats du propriétaire du 2026-11-04, diagnostiqués mais volontairement laissés en l’état pour ne rien casser :

- **« Lire la phrase » doit parfois être pressé deux fois** pour avoir du son, parfois dès le chargement de la page.
  - Cause la plus probable, avec eSpeak NG et Piper : la sortie audio (`BufferPlayer`, `src/engines/browser.ts`) est créée après la synthèse, et la première fois après le téléchargement de la voix Piper, donc hors du geste de l’utilisateur ; le navigateur la laisse en pause (règle anti-lecture automatique). Le deuxième clic, nouveau geste, la débloque. Les tests de l’agent tournaient avec cette règle désactivée (`--autoplay-policy=no-user-gesture-required`), d’où l’absence de détection.
  - Avec WaxVocoder, au premier clic : le son n’arrive qu’une fois le moteur WASM prêt dans l’AudioWorklet ; un deuxième clic pendant l’attente devient « Arrêter ».
  - Piste : créer et débloquer une seule sortie audio au premier clic, pour tous les moteurs, puis y jouer la voix une fois prête ; afficher un état « chargement » sur la touche.
- **Toucher au bypass Robot (ou au tempo, à la mélodie, au débit) en pleine lecture oblige à relancer la voix.**
  - Une phrase est jouée une seule fois. Avec eSpeak NG et Piper, l’étage robot est calculé avant la lecture : les changements de Voix et de Robot ne s’entendent qu’à la lecture suivante (seul le module Effets agit en direct).
  - Avec WaxVocoder, ces réglages recalculent le minutage de la phrase en cours (`Voice::replan`) ; si la phrase raccourcit (bypass Robot qui retire le tempo), la position dépasse sa fin et le moteur l’arrête.
  - Pistes : relancer automatiquement la phrase après un tel changement (ou un mode boucle), et garder la position relative lors d’un recalcul.
- **Exporter pendant la lecture** : l’export se fait, mais le message « WAV exporté » est aussitôt remplacé par l’indicateur de lecture (« Lecture · crête … »). Piste : ne pas écraser un message d’export récent.

## Versions épinglées

- Vite 8.3.5
- TypeScript 7.0.2
- wasm-bindgen 0.2.129
- @echogarden/espeak-ng-emscripten 0.3.5
