# Synthétiseur vocal musical — note de cadrage

**Document de discussion — version 0.1**  
**Statut :** proposition à valider avec les associés  
**Nom de travail :** à définir

## 1. Résumé

Créer un instrument logiciel autonome qui transforme du texte en voix synthétique jouable et expressive. Le projet vise d’abord les voix électroniques articulées, avec une identité sonore inspirée notamment de Kraftwerk, tout en permettant des rendus plus doux ou plus proches de la parole.

Le produit sera développé comme une application web indépendante. Son moteur audio sera écrit en Rust et compilable en WebAssembly (WASM). Cette séparation doit permettre de faire évoluer l’application sans dépendre d’un hôte particulier, puis d’envisager son intégration dans NoobSynth3 ou d’autres environnements si cela apporte une valeur réelle.

## 2. Besoin et opportunité

Les musiciens peuvent facilement appliquer un effet vocoder à une voix enregistrée, mais obtenir une phrase articulée, réglable et jouable à partir de texte est un problème différent. Le projet réunit dans un instrument musical :

- la conversion du texte en phonèmes et en rythme ;
- la synthèse d’une voix électronique intelligible ;
- le contrôle musical de la hauteur, du débit et de l’articulation ;
- le vocodage de cette voix par une porteuse synthétique ou une entrée audio.

L’objectif initial n’est pas de concurrencer les services généralistes de synthèse vocale réaliste. Il est de proposer un instrument créatif, prévisible et adapté à la production musicale.

## 3. Vision produit

L’utilisateur saisit ou importe une phrase, choisit une langue et un style vocal, ajuste sa prononciation et son rythme, puis joue ou exporte le résultat. Il peut utiliser la voix synthétique seule ou la faire passer dans un vocoder alimenté par une porteuse intégrée ou externe.

### Modes envisagés

1. **Voix synthétique** — parole générée par synthèse articulatoire ou à formants, avec réglage du timbre et de l’intonation.
2. **Voix robotique** — articulation nette, hauteur maîtrisée et timbres électroniques pour des phrases musicales courtes.
3. **Voix vocodée** — la voix générée sert de modulateur ; un oscillateur, un synthétiseur ou une entrée audio fournit la porteuse.
4. **Mode jouable** — déclenchement et contrôle des phonèmes ou segments par notes, gate et contrôles MIDI/Web MIDI selon les possibilités du navigateur.

Les modes et leur ordre de réalisation restent à confirmer. La première version doit privilégier la qualité et le contrôle d’un cas d’usage restreint plutôt que multiplier les fonctions.

## 4. Public et usages

- Musiciens électroniques, producteurs et concepteurs sonores.
- Création de slogans, refrains, phrases rythmiques et textures vocales.
- Travail en studio dans un navigateur, avec écoute et export audio.
- À terme, intégration à des synthétiseurs modulaires et stations de travail compatibles.

## 5. Périmètre proposé pour le prototype

Le prototype doit démontrer une boucle complète :

- saisie d’une phrase dans une langue définie ;
- génération d’une séquence de phonèmes et possibilité de la corriger ;
- réglage de la vitesse, de la hauteur, du timbre et de l’articulation ;
- lecture temps réel dans le navigateur ;
- au moins deux styles vocaux contrastés ;
- porteuse synthétique simple et vocoder activable ;
- export audio d’une phrase rendue ;
- documentation de l’interface entre l’application et le moteur.

Le prototype ne vise pas encore une voix humaine indiscernable, un grand nombre de langues, une compatibilité garantie avec tous les navigateurs, ni un plugin natif VST/AU.

## 6. Architecture de principe

```text
Interface web
  ├── texte, phonèmes, styles et paramètres
  ├── édition et aperçu de la séquence
  └── commandes de lecture et d’export
          │ messages de contrôle
          ▼
AudioWorklet ─── moteur Rust compilé en WASM
                         ├── phonèmes et articulation
                         ├── source vocale et formants
                         ├── porteuse synthétique
                         └── vocoder et sortie audio
```

Principes d’architecture :

- le moteur DSP ne dépend ni de l’interface graphique ni de NoobSynth3 ;
- l’audio temps réel s’exécute dans un `AudioWorklet`, avec WASM pour le traitement DSP ;
- l’interface transmet des commandes et paramètres selon un protocole documenté ;
- les structures de données de phrases, phonèmes et presets sont versionnées ;
- le moteur doit pouvoir être réutilisé dans d’autres interfaces web, puis potentiellement dans d’autres hôtes.

L’intégration future pourra prendre plusieurs formes (module WASM, composant web, API de messages, ou plugin natif). Le choix dépendra des besoins des hôtes et sera évalué après stabilisation du moteur.

## 7. Références sonores

La référence artistique principale est la voix électronique articulée associée à Kraftwerk. Daft Punk peut servir de référence secondaire pour des voix plus brillantes et fortement vocodées.

Pour le vocoder, on peut étudier les caractéristiques générales de machines historiques telles que le Sennheiser VSM 201 et le Roland VP-330 : répartition des bandes, dynamique, sibilantes, filtrage et couleur. Il s’agit de références d’écoute et de conception, pas d’une promesse de reproduction exacte. La voix, l’articulation et la porteuse contribuent autant au résultat que le vocoder lui-même.

## 8. Feuille de route proposée

| Étape | Résultat attendu | Critère de passage |
|---|---|---|
| 0. Cadrage | Cas d’usage prioritaire, langue initiale, plateformes et critères de qualité décidés | Accord des associés sur le prototype |
| 1. Démonstrateur vocal | Texte transformé en phonèmes puis rendu par le moteur Rust/WASM dans le navigateur | Phrases courtes compréhensibles et lecture stable |
| 2. Contrôle musical | Édition des phonèmes, durées, hauteur et styles vocaux | L’utilisateur peut corriger et façonner une phrase sans outil externe |
| 3. Porteuse et vocoder | Porteuse intégrée, vocoder réglable et routage audio utile | Résultat convaincant sur plusieurs phrases et porteuses |
| 4. Application bêta | Presets, sauvegarde, export et documentation utilisateur | Parcours complet de création et de partage |
| 5. Interopérabilité | Prototype d’intégration dans un hôte choisi, éventuellement NoobSynth3 | Intégration évaluée sans coupler le cœur du produit à cet hôte |

Les durées et budgets ne sont pas estimés ici : ils dépendront des compétences disponibles, de la langue de départ et du niveau de qualité vocale attendu.

## 9. Risques et sujets à clarifier

- **Intelligibilité :** une synthèse très robotique peut devenir difficile à comprendre ; les phonèmes et transitions demandent une écoute attentive.
- **Langues :** la conversion texte-phonèmes dépend fortement de la langue, des règles de prononciation et des exceptions.
- **Temps réel :** le traitement doit rester stable avec une latence acceptable dans les navigateurs ciblés.
- **Différence entre parole et chant :** la synthèse de parole pilotée par texte ne garantit pas une performance chantée convaincante. La mélodie et l’alignement texte-notes peuvent devenir un chantier distinct.
- **Interopérabilité :** les hôtes ne partagent pas tous les mêmes formats de plugin, API ou capacités audio.
- **Droits et identité :** utiliser des références artistiques comme inspiration sonore ne signifie pas cloner une voix d’artiste ni réutiliser des enregistrements protégés.
- **Licences :** les dépendances, modèles linguistiques et éventuelles données vocales devront être vérifiés avant distribution commerciale.

## 10. Décisions à prendre avec les associés

1. Quel est le premier utilisateur visé : producteur débutant, sound designer ou musicien expérimenté ?
2. Quelle langue doit être prise en charge en premier : anglais ou français ?
3. Le premier jalon privilégie-t-il l’intelligibilité, le caractère Kraftwerk ou la jouabilité rythmique ?
4. L’application web doit-elle fonctionner entièrement hors ligne dès la première version ?
5. Le MIDI est-il nécessaire dans le prototype, ou le déclenchement depuis l’interface suffit-il ?
6. Quel est le modèle de distribution envisagé : gratuit, open source, commercial ou combinaison de ces options ?
7. Quels appareils et navigateurs constituent la cible initiale ?

## 11. Proposition de décision

Valider une phase de cadrage technique et artistique courte, suivie d’un démonstrateur web autonome. Pour ce démonstrateur, choisir une seule langue, une phrase courte comme cas de référence et quelques styles vocaux clairement différenciés. Évaluer l’intelligibilité, le caractère sonore, la jouabilité et les performances avant d’élargir le périmètre ou de commencer l’intégration à un hôte externe.
