//! `train <data.bin> <out-dir> <superbatches> <batches-per-superbatch> <threads> [initial-lr] [wdl] [net-id] [valid.bin]`
//!
//! The ChessVision 2.0.3 AggroChess network, trained with bullet's CPU backend on bulletformat data (see convert.rs):
//! (768 x 3 mirrored king buckets -> 512) x 2 -> SCReLU -> 1, 8 output buckets by piece count (as AggroChess 4.6.1),
//! with a factoriser (weights shared by the buckets while training, merged into each bucket when saved).
//! Quantisation as AggroChess: QA 255, QB 64, eval scale 400. The quantised net (`quantised.bin` in each checkpoint)
//! is turned into the engine's file by `pack`.
use bullet_lib::{
    game::{inputs::{get_num_buckets, ChessBucketsMirrored}, outputs::MaterialCount},
    nn::{optimiser::{AdamW, AdamWParams}, InitSettings, Shape},
    trainer::{
        save::SavedFormat,
        schedule::{lr, wdl, TrainingSchedule, TrainingSteps},
        settings::{LocalSettings, TestDataset},
    },
    value::{loader::DirectSequentialDataLoader, ValueTrainerBuilder},
};

pub const HL: usize = 512;
/// King buckets, files a-d of each rank from rank 1 up (the board is mirrored so the king is always on files a-d):
/// 0 = sheltered in a corner (a/b/g/h files, ranks 1-2), 1 = central on the back two ranks (c-f), 2 = advanced (rank 3+).
#[rustfmt::skip]
pub const BUCKET_LAYOUT: [usize; 32] = [
    0, 0, 1, 1,
    0, 0, 1, 1,
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
    2, 2, 2, 2,
];
const OUTPUT_BUCKETS: usize = 8;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    assert!(a.len() >= 5, "usage: train <data.bin> <out-dir> <superbatches> <batches-per-superbatch> <threads> [initial-lr] [wdl] [net-id]");
    let (data, out_dir) = (a[0].clone(), a[1].clone());
    let superbatches: usize = a[2].parse().unwrap();
    let per_sb: usize = a[3].parse().unwrap();
    let threads: usize = a[4].parse().unwrap();
    let initial_lr: f32 = a.get(5).map(|s| s.parse().unwrap()).unwrap_or(0.001);
    let wdl_proportion: f32 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(0.3);
    let net_id = a.get(7).cloned().unwrap_or_else(|| "aggro-768x3hm-512".to_string());
    let valid = a.get(8).cloned();
    const NB: usize = get_num_buckets(&BUCKET_LAYOUT);

    let mut trainer = ValueTrainerBuilder::default()
        .dual_perspective()
        .optimiser(AdamW)
        .inputs(ChessBucketsMirrored::new(BUCKET_LAYOUT))
        .output_buckets(MaterialCount::<OUTPUT_BUCKETS>)
        .use_threads(threads)
        .save_format(&[
            SavedFormat::id("l0w")
                .transform(|store, weights| {
                    let factoriser = store.get("l0f").values.repeat(NB);
                    weights.into_iter().zip(factoriser).map(|(a, b)| a + b).collect()
                })
                .round()
                .quantise::<i16>(255),
            SavedFormat::id("l0b").round().quantise::<i16>(255),
            SavedFormat::id("l1w").round().quantise::<i16>(64).transpose(),
            SavedFormat::id("l1b").round().quantise::<i16>(255 * 64),
        ])
        .loss_fn(|output, target| output.sigmoid().squared_error(target))
        .build(|builder, stm_inputs, ntm_inputs, output_buckets| {
            let l0f = builder.new_weights("l0f", Shape::new(HL, 768), InitSettings::Zeroed);
            let expanded_factoriser = l0f.repeat(NB);
            let mut l0 = builder.new_affine("l0", 768 * NB, HL);
            l0.weights = l0.weights + expanded_factoriser;
            let l1 = builder.new_affine("l1", 2 * HL, OUTPUT_BUCKETS);
            let stm_hidden = l0.forward(stm_inputs).screlu();
            let ntm_hidden = l0.forward(ntm_inputs).screlu();
            l1.forward(stm_hidden.concat(ntm_hidden)).select(output_buckets)
        });

    // merged bucket weight = bucket + factoriser, each clipped to +-0.99: |merged| * 255 < 2^9, and QA * |out weight| * 64
    // stays inside i16 for the engine's v * (v * w) SCReLU (out weights clipped to +-1.98 by default: 255 * 127 < 2^15)
    let stricter = AdamWParams { max_weight: 0.99, min_weight: -0.99, ..Default::default() };
    trainer.optimiser.set_params_for_weight("l0w", stricter);
    trainer.optimiser.set_params_for_weight("l0f", stricter);

    let schedule = TrainingSchedule {
        net_id,
        eval_scale: 400.0,
        steps: TrainingSteps { batch_size: 16_384, batches_per_superbatch: per_sb, start_superbatch: 1, end_superbatch: superbatches },
        wdl_scheduler: wdl::ConstantWDL { value: wdl_proportion },
        lr_scheduler: lr::CosineDecayLR { initial_lr, final_lr: initial_lr * 0.3f32.powi(5), final_superbatch: superbatches },
        save_rate: 5,
    };
    let test_set = valid.as_deref().map(|path| TestDataset { path, freq: 64 });
    let settings = LocalSettings { threads: 1, test_set, output_directory: &out_dir, batch_queue_size: 32 };
    let loader = DirectSequentialDataLoader::new(&[data.as_str()]);
    trainer.run(&schedule, &settings, &loader);
}
